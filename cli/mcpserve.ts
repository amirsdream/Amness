// `amness mcp serve`: Amness as an MCP server, so Claude Code, Codex and other MCP clients can hand it a task.
// A coding agent does not fit one tool call (long runs, approvals, follow-ups), so the tools work on explicit session handles
// (MCP 2026-07-28's stateful-tool pattern): amness_run starts one, amness_status / amness_reply / amness_answer continue it.
// Speaks 2026-07-28 (stateless, server/discover, MRTR for questions) and the initialize-handshake versions (questions as elicitation/create requests).
// Over stdio (`amness mcp serve`) and over Streamable HTTP at /mcp on `amness serve` (same token, same sessions as the app and the /v1 API).
import { createInterface } from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiSessions, MODES, type SessionView } from "./serve/sessions.ts";

const MODERN = "2026-07-28", LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const V = "io.modelcontextprotocol/protocolVersion";
const WAIT = 50;                                                                                      // seconds: under Codex's default 60 s tool timeout; then the caller polls amness_status

export const MCP_SERVE_HELP = `amness mcp serve [--root <folder>]… [--model <ref>] [--mode default|acceptEdits|plan|yolo]
  Amness as an MCP server over stdio, for Claude Code, Codex and other MCP clients. Tools: amness_run, amness_status,
  amness_reply, amness_answer, amness_sessions, amness_close. Sessions may use only --root folders (default: this folder).
  Claude Code:  claude mcp add amness -- amness mcp serve
  Codex:        codex mcp add amness -- amness mcp serve
  Remote: amness serve also answers MCP at http(s)://<host>:<port>/mcp (send Authorization: Bearer <token>).`;

const TOOLS = [
  { name: "amness_run", title: "Run a task with Amness", description: "Start an Amness coding-agent session on a task in a folder and wait up to wait_seconds for it. Returns the session id, its status (idle = done, running, waiting = it needs an answer), the final answer when done, or the pending question. Continue with amness_status, amness_reply or amness_answer. Sessions stay open until amness_close.",
    inputSchema: { type: "object", required: ["task"], additionalProperties: false, properties: { task: { type: "string", description: "what to do, as you would tell a developer" }, cwd: { type: "string", description: "the project folder (must be one the server allows)" }, model: { type: "string", description: "a model id, provider:model or server:<name>; default: the user's model" }, mode: { type: "string", enum: MODES, description: "permission mode; default asks before edits and commands" }, wait_seconds: { type: "integer", minimum: 0, maximum: 3600, description: `how long to wait before returning (default ${WAIT})` } } },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: "amness_status", title: "Session status", description: "The status of an Amness session, waiting up to wait_seconds for it to finish or ask something. Returns the answer when done, or the pending question.",
    inputSchema: { type: "object", required: ["session"], additionalProperties: false, properties: { session: { type: "string" }, wait_seconds: { type: "integer", minimum: 0, maximum: 3600 } } }, annotations: { readOnlyHint: true } },
  { name: "amness_reply", title: "Send a follow-up", description: "Send a follow-up message to an Amness session (a correction, the next step, an answer in words) and wait like amness_run.",
    inputSchema: { type: "object", required: ["session", "text"], additionalProperties: false, properties: { session: { type: "string" }, text: { type: "string" }, wait_seconds: { type: "integer", minimum: 0, maximum: 3600 } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "amness_answer", title: "Answer a question", description: "Answer the question or approval an Amness session is waiting for: choice = the option number shown (1 is the first), or text for a question that wants text, or \"cancel\". Only approve what the user would approve.",
    inputSchema: { type: "object", required: ["session", "dialog", "choice"], additionalProperties: false, properties: { session: { type: "string" }, dialog: { type: "integer", description: "the question's id" }, choice: { type: "string", description: "an option number, the text, or cancel" }, wait_seconds: { type: "integer", minimum: 0, maximum: 3600 } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "amness_sessions", title: "Open sessions", description: "The open Amness sessions with their status.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } },
  { name: "amness_close", title: "Close a session", description: "Close an Amness session (its conversation stays saved).", inputSchema: { type: "object", required: ["session"], additionalProperties: false, properties: { session: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
];

type Ctx = { elicitLegacy?: (params: unknown) => Promise<any>; modernElicit: boolean };
const text = (s: string, isError = false, structured?: unknown) => ({ resultType: "complete", content: [{ type: "text", text: s }], ...(structured !== undefined && { structuredContent: structured }), ...(isError && { isError: true }) });

/** What the caller reads about a session: status, the answer, or the question with numbered options. */
function describe(v: SessionView): string {
  const head = `session ${v.id} · ${v.status}${v.status === "running" ? " (call amness_status to wait more)" : ""} · ${v.model} · ${v.cwd}`;
  if (v.status === "waiting" && v.dialog) {
    const d = v.dialog as any, opts = (d.options ?? d.items ?? []).map((o: any, i: number) => `  ${i + 1}. ${strip(o.label)}${o.hint ? ` (${strip(o.hint)})` : ""}`);
    const what = strip(d.question ?? d.title ?? d.prompt ?? "a question");
    return `${head}\nWAITING FOR AN ANSWER (dialog ${d.id}): ${what}\n${(d.body ?? []).map(strip).slice(0, 30).join("\n")}\n${opts.join("\n")}\nAnswer with amness_answer (session ${v.id}, dialog ${d.id}, choice = a number${d.kind === "input" || d.kind === "longtext" ? " or the text" : ""}).`.replace(/\n+/g, "\n");
  }
  return v.status === "idle" ? `${head}\n\n${v.lastAnswer ?? "(no answer text)"}` : head;
}
const strip = (s: string) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

export function createMcpServer(sessions: ApiSessions, o: { version: string; defaults?: { model?: string; mode?: string } }) {
  /** Wait until the session is idle or waiting, at most `secs`. */
  const settle = async (id: string, secs: number) => {
    const until = Date.now() + secs * 1000; await new Promise((r) => setTimeout(r, 150));          // the session's status follows the App a moment later
    for (;;) { const v = sessions.view(id); if (v.status !== "running" || Date.now() >= until) return v; await new Promise((r) => setTimeout(r, 150)); }
  };
  /** Questions go to the caller's user when the caller can ask (elicitation); else the caller's agent sees them in the result. */
  const ask = async (v: SessionView, ctx: Ctx, call: { params: any }): Promise<{ result?: any; v: SessionView }> => {
    if (v.status !== "waiting" || !v.dialog) return { v };
    const d = v.dialog as any, opts: string[] = (d.options ?? d.items ?? []).map((x: any) => strip(x.label));
    const message = `Amness (${v.project}) asks: ${strip(d.question ?? d.title ?? d.prompt ?? "")}${d.body?.length ? `\n${d.body.map(strip).slice(0, 12).join("\n")}` : ""}`;
    const schema = opts.length ? { type: "object", required: ["choice"], properties: { choice: { type: "string", title: "Answer", enum: opts } } } : { type: "object", required: ["text"], properties: { text: { type: "string", title: "Answer" } } };
    const apply = (r: any): boolean => {
      if (r?.action !== "accept") { sessions.answer(v.id, d.id, null); return true; }
      if (opts.length) { const i = opts.indexOf(String(r.content?.choice)); if (i < 0) return false; sessions.answer(v.id, d.id, i); return true; }
      sessions.answer(v.id, d.id, String(r.content?.text ?? "")); return true;
    };
    if (ctx.elicitLegacy) { const r = await ctx.elicitLegacy({ message, requestedSchema: schema }).catch(() => undefined); if (r && apply(r)) return { v: sessions.view(v.id) }; return { v }; }
    if (ctx.modernElicit) {                                                                            // MRTR: return the question; the client retries with the answer
      const key = `q${d.id}`, resp = call.params?.inputResponses?.[key];
      if (resp && call.params?.requestState === `${v.id}:${d.id}` && apply(resp)) return { v: sessions.view(v.id) };
      return { v, result: { resultType: "input_required", inputRequests: { [key]: { method: "elicitation/create", params: { mode: "form", message, requestedSchema: schema } } }, requestState: `${v.id}:${d.id}` } };
    }
    return { v };
  };
  const callTool = async (name: string, a: any, ctx: Ctx, call: { params: any }) => {
    const secs = Math.max(0, Math.min(3600, Number(a?.wait_seconds ?? WAIT)));
    const finish = async (id: string) => {
      let v = await settle(id, secs);
      for (let i = 0; i < 20 && v.status === "waiting"; i++) {                                        // answer questions through the caller while there is time
        const r = await ask(v, ctx, call); if (r.result) return r.result; if (r.v === v) break;          // nobody to ask: the caller's agent gets the question
        v = await settle(id, Math.max(1, secs));
      }
      return text(describe(v), false, { session: v.id, status: v.status, answer: v.status === "idle" ? v.lastAnswer ?? "" : undefined, dialog: v.status === "waiting" ? v.dialog : undefined });
    };
    switch (name) {
      case "amness_run": {
        if (call.params?.inputResponses && call.params?.requestState) return finish(String(call.params.requestState).split(":")[0]);   // a retry with the answer to our question
        const s = await sessions.create({ cwd: a.cwd, model: a.model ?? o.defaults?.model, mode: (a.mode ?? o.defaults?.mode) as never, title: String(a.task).slice(0, 80) });
        await sessions.send(s.id, String(a.task), { wait: true, timeoutMs: secs * 1000 }); return finish(s.id);
      }
      case "amness_status": return finish(String(a.session));
      case "amness_reply": { if (!(call.params?.inputResponses && call.params?.requestState)) await sessions.send(String(a.session), String(a.text), { wait: true, timeoutMs: secs * 1000 }); return finish(String(a.session)); }
      case "amness_answer": {
        const v = sessions.view(String(a.session)); if (!v.dialog || v.dialog.id !== Number(a.dialog)) return text(`dialog ${a.dialog} is not open in session ${a.session} (open: ${v.dialog?.id ?? "none"})`, true);
        const c = String(a.choice).trim(), d = v.dialog as any;
        sessions.answer(v.id, d.id, /^cancel$/i.test(c) ? null : /^\d+$/.test(c) && (d.options ?? d.items) ? Number(c) - 1 : c);
        return finish(v.id);
      }
      case "amness_sessions": { const l = sessions.list().open; return text(l.length ? l.map((v) => `${v.id} · ${v.status} · ${v.title} · ${v.cwd}`).join("\n") : "no open sessions", false, { sessions: l.map((v) => ({ id: v.id, status: v.status, title: v.title, cwd: v.cwd })) }); }
      case "amness_close": sessions.close(String(a.session)); return text(`closed ${a.session}`);
      default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
  };
  const serverInfo = { name: "amness", title: "Amness", version: o.version };
  /** One JSON-RPC request → its result, or throws {code, message}. */
  const handle = async (m: any, ctx: Ctx & { legacy?: boolean }): Promise<any> => {
    const p = m.params ?? {}, meta = p._meta ?? {};
    if (m.method === "initialize") return { protocolVersion: LEGACY.includes(p.protocolVersion) ? p.protocolVersion : LEGACY[0], capabilities: { tools: { listChanged: false } }, serverInfo, instructions: "Use amness_run to give Amness a coding task in a project folder; continue with amness_status, amness_reply and amness_answer." };
    if (m.method === "ping") return {};
    if (!ctx.legacy && meta[V] && meta[V] !== MODERN) throw { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN, ...LEGACY], requested: meta[V] } };
    const out = (r: any) => (ctx.legacy ? r : { ...r, resultType: r.resultType ?? "complete", _meta: { ...r._meta, "io.modelcontextprotocol/serverInfo": serverInfo } });
    if (m.method === "server/discover") return out({ supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: { listChanged: false } }, instructions: "Use amness_run to give Amness a coding task in a project folder; continue with amness_status, amness_reply and amness_answer." });
    if (m.method === "tools/list") return out({ tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" });
    if (m.method === "tools/call") {
      const t = TOOLS.find((x) => x.name === p.name); if (!t) throw { code: -32602, message: `Unknown tool: ${p.name}` };
      try { return out(await callTool(p.name, p.arguments ?? {}, ctx, { params: p })); }
      catch (e) { return out(text(`ERROR: ${(e as Error).message}`, true)); }                     // tool execution errors go to the calling model
    }
    throw { code: -32601, message: `Method not found: ${m.method}` };
  };
  return { handle };
}

/** stdio: newline-delimited JSON-RPC. Legacy clients get questions as elicitation/create requests when they declared elicitation. */
export async function serveMcpStdio(sessions: ApiSessions, o: { version: string; defaults?: { model?: string; mode?: string }; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) {
  const input = o.input ?? process.stdin, output = o.output ?? process.stdout, srv = createMcpServer(sessions, o);
  const send = (m: unknown) => output.write(JSON.stringify(m) + "\n");
  let legacy = false, legacyElicit = false, nid = 0; const pending = new Map<string, (r: any) => void>();
  const elicitLegacy = (params: unknown) => new Promise<any>((res) => { const id = `amness-${++nid}`; pending.set(id, res); send({ jsonrpc: "2.0", id, method: "elicitation/create", params }); });
  await new Promise<void>((done) => {
    const rl = createInterface({ input });
    rl.on("line", (line) => {
      let m: any; try { m = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      if (!m.method && m.id !== undefined) { pending.get(String(m.id))?.(m.result ?? { action: "cancel" }); pending.delete(String(m.id)); return; }
      if (m.method === "initialize") { legacy = true; legacyElicit = !!m.params?.capabilities?.elicitation; }
      if (m.id === undefined) return;                                                                // notifications (initialized, cancelled)
      const modernElicit = !legacy && !!m.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.elicitation;
      void srv.handle(m, { legacy, modernElicit, ...(legacy && legacyElicit && { elicitLegacy }) })
        .then((result) => send({ jsonrpc: "2.0", id: m.id, result }), (e) => send({ jsonrpc: "2.0", id: m.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e), ...(e?.data && { data: e.data }) } }));
    });
    rl.on("close", () => done());
  });
}

/** Streamable HTTP at /mcp (for `amness serve`): one POST per request, a JSON answer; no sessions, no GET stream. The caller must send the token. */
export function mcpHttpRoute(sessions: ApiSessions, o: { version: string }) {
  const srv = createMcpServer(sessions, o);
  return async (req: IncomingMessage, res: ServerResponse, authed: boolean) => {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
    if (!authed) { res.writeHead(401, { "www-authenticate": 'Bearer realm="amness"', "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "send Authorization: Bearer <token> (amness serve token)" } })); return; }
    let body = ""; for await (const c of req) { body += c; if (body.length > 4 << 20) { res.writeHead(413).end(); return; } }
    let m: any; try { m = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); return; }
    if (m.id === undefined) { res.writeHead(202).end(); return; }
    const hv = req.headers["mcp-protocol-version"], legacy = m.method === "initialize" || (typeof hv === "string" && hv !== MODERN);
    if (!legacy && m.method !== "initialize") {                                                       // 2026-07-28: the mirrored headers must match the body
      const meta = m.params?._meta?.[V];
      if (hv !== MODERN || meta !== MODERN || req.headers["mcp-method"] !== m.method) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32020, message: "Header mismatch: MCP-Protocol-Version, _meta and Mcp-Method must agree" } })); return; }
    }
    const modernElicit = !legacy && !!m.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.elicitation;
    try { const result = await srv.handle(m, { legacy, modernElicit }); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); }
    catch (e: any) { res.writeHead(e?.code === -32601 ? 404 : 400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e), ...(e?.data && { data: e.data }) } })); }
  };
}

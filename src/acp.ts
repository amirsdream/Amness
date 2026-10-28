// Agent Client Protocol server: lets an editor (Zed, JetBrains, ...) host Amness as its coding agent. JSON-RPC 2.0, one JSON message per line over stdio.
// Implemented: initialize, session/new, session/prompt (streams text and tool calls back as session/update), session/cancel, and session/request_permission for risky calls.
// Not implemented: session/load, authenticate, fs/* and terminal/* (Amness reads and runs things itself), non-text prompt content other than images and embedded resources.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Approve, Event, Message } from "./harness.ts";

type Json = any;
export type AcpAgent = { chat: (history: Message[], text: string, extra?: { images?: { mime: string; data: string }[] }) => Promise<{ messages: Message[]; text: string; stopped?: string; finished: boolean }>; };
export type AcpOptions = {
  input: Readable; output: Writable; version: string;
  /** Build an agent for a session. `onEvent` and `approve` must be wired into it; `signal` is aborted by session/cancel. */
  makeAgent: (s: { cwd: string; onEvent: (e: Event) => void; approve: Approve; signal: () => AbortSignal | undefined }) => AcpAgent;
};
const KIND: Record<string, string> = { read_file: "read", list_dir: "read", grep: "search", find_refs: "search", repo_map: "search", write_file: "edit", edit_file: "edit", apply_patch: "edit", sh: "execute", sh_start: "execute", web_fetch: "fetch", web_search: "fetch" };

export function serveAcp(o: AcpOptions): Promise<void> {
  const send = (m: Json) => o.output.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const sessions = new Map<string, { cwd: string; history: Message[]; ac?: AbortController; agent: AcpAgent }>();
  const waiting = new Map<number | string, (r: Json) => void>(); let nextId = 1, n = 0;
  const call = (method: string, params: Json) => new Promise<Json>((res) => { const id = nextId++; waiting.set(id, res); send({ id, method, params }); });
  const update = (sessionId: string, u: Json) => send({ method: "session/update", params: { sessionId, update: u } });

  const newSession = (cwd: string) => {
    const id = `sess_${Date.now().toString(36)}${(++n).toString(36)}`, s: { cwd: string; history: Message[]; ac?: AbortController; agent: AcpAgent } = { cwd, history: [], agent: undefined as any };
    const onEvent = (e: Event) => {
      if (e.kind === "text") update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta } });
      else if (e.kind === "thinking") update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta } });
      else if (e.kind === "toolstart") update(id, { sessionUpdate: "tool_call", toolCallId: e.id, title: `${e.name} ${e.args.slice(0, 80)}`, kind: KIND[e.name] ?? "other", status: "in_progress" });
      else if (e.kind === "tool" && e.id) update(id, { sessionUpdate: "tool_call_update", toolCallId: e.id, status: /^(ERROR|DENIED|REJECTED)/.test(e.result) ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: e.result.slice(0, 4000) } }] });
      else if (e.kind === "todos") update(id, { sessionUpdate: "plan", entries: e.todos.map((t) => ({ content: t.content, priority: "medium", status: t.status === "done" ? "completed" : t.status })) });
    };
    const approve: Approve = async (req) => {
      const r = await call("session/request_permission", { sessionId: id, toolCall: { toolCallId: req.id ?? `perm_${++n}`, title: `${req.name}: ${req.reason ?? "needs approval"}`, kind: KIND[req.name] ?? "other", status: "pending", rawInput: req.args, ...(req.preview && { content: [{ type: "content", content: { type: "text", text: req.preview.slice(0, 4000) } }] }) },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
      const out = r?.outcome; return out?.outcome === "selected" && out.optionId === "allow" ? true : "the user rejected this in the editor";
    };
    s.agent = o.makeAgent({ cwd, onEvent, approve, signal: () => s.ac?.signal }); sessions.set(id, s); return id;
  };

  const toText = (blocks: Json[]): { text: string; images: { mime: string; data: string }[] } => {
    const parts: string[] = [], images: { mime: string; data: string }[] = [];
    for (const b of blocks ?? []) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "image" && b.data) images.push({ mime: b.mimeType ?? "image/png", data: b.data });
      else if (b.type === "resource" && b.resource?.text !== undefined) parts.push(`<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>`);
      else if (b.type === "resource_link" && b.uri) parts.push(`(see ${b.uri})`);
    }
    return { text: parts.join("\n\n"), images };
  };

  const handle = async (m: Json) => {
    const ok = (result: Json) => send({ id: m.id, result }), fail = (code: number, message: string) => send({ id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case "initialize": return ok({ protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } }, agentInfo: { name: "amness", title: "Amness", version: o.version }, authMethods: [] });
        case "session/new": return ok({ sessionId: newSession(m.params?.cwd || process.cwd()) });
        case "session/prompt": {
          const s = sessions.get(m.params?.sessionId); if (!s) return fail(-32602, "unknown session");
          if (s.ac) return fail(-32000, "a turn is already running in this session");
          const { text, images } = toText(m.params.prompt); s.ac = new AbortController();
          try {
            const r = await s.agent.chat(s.history, text, { images }); s.history = r.messages;
            const stop = s.ac.signal.aborted ? "cancelled" : r.stopped === "budget" || r.stopped === "maxSteps" ? "max_turn_requests" : "end_turn";
            return ok({ stopReason: stop });
          } finally { s.ac = undefined; }
        }
        case "session/cancel": sessions.get(m.params?.sessionId)?.ac?.abort(); return;                  // a notification: no reply
        case "authenticate": return ok({});
        default: if (m.id !== undefined) return fail(-32601, `method not found: ${m.method}`);
      }
    } catch (e) { if (m.id !== undefined) fail(-32603, (e as Error).message); }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: o.input });
    rl.on("line", (line) => {
      if (!line.trim()) return; let m: Json; try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "parse error" } }); }
      if (m.method) void handle(m); else if (m.id !== undefined) { waiting.get(m.id)?.(m.result ?? { error: m.error }); waiting.delete(m.id); }
    });
    rl.on("close", () => { for (const s of sessions.values()) s.ac?.abort(); for (const w of waiting.values()) w({}); resolve(); });
  });
}

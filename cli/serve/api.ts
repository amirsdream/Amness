// The public HTTP API of `amness serve`: /v1, JSON over HTTP plus Server-Sent Events. Every route but /v1/health and /v1/openapi.json needs the token
// (Authorization: Bearer <token>, or x-amness-token; an EventSource may pass ?t=<token>). The shape is documented in OPENAPI below and in docs/api.md.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiSessions, MODES, type SessionEvent } from "./sessions.ts";

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req: IncomingMessage, limit = 4 << 20) => new Promise<any>((ok, fail) => {
  let n = 0; const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => { n += c.length; if (n > limit) { fail(Object.assign(new Error("request too large"), { status: 413 })); req.destroy(); } else parts.push(c); });
  req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { fail(Object.assign(new Error("bad JSON"), { status: 400 })); } });
  req.on("error", fail);
});

/** The /v1 routes over `sessions`. Returns a handler for startDesktopServer's `net.extra`. */
export function v1Routes(sessions: ApiSessions, o: { version: string }) {
  const streams = new Set<ServerResponse>();
  const ping = setInterval(() => { for (const s of streams) s.write(": ping\n\n"); }, 20_000); ping.unref?.();
  const stream = (req: IncomingMessage, res: ServerResponse, only?: string) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": hello\n\n"); streams.add(res);
    const off = sessions.subscribe((e: SessionEvent) => { if (!only || e.session === only) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); });
    req.on("close", () => { off(); streams.delete(res); });
  };
  const handler = async (req: IncomingMessage, res: ServerResponse, u: URL, authed: boolean): Promise<boolean> => {
    const path = u.pathname.replace(/\/+$/, ""), m = req.method ?? "GET";
    if (path === "/v1/health" && m === "GET") { json(res, 200, { ok: true, version: o.version, sessions: sessions.size }); return true; }
    if (path === "/v1/openapi.json" && m === "GET") { json(res, 200, OPENAPI(o.version)); return true; }
    if (!authed) { res.setHeader("www-authenticate", 'Bearer realm="amness"'); json(res, 401, { error: "unauthorised: send Authorization: Bearer <token> (amness serve token)" }); return true; }
    try {
      if (path === "/v1/events" && m === "GET") { stream(req, res); return true; }
      if (path === "/v1/sessions" && m === "GET") { json(res, 200, sessions.list(u.searchParams.has("saved") ? { saved: u.searchParams.get("saved") ?? "" } : {})); return true; }
      if (path === "/v1/sessions" && m === "POST") { const b = await readBody(req); json(res, 201, await sessions.create({ cwd: str(b.cwd), resume: str(b.resume), model: str(b.model), mode: str(b.mode) as never, title: str(b.title) })); return true; }
      const mm = /^\/v1\/sessions\/([\w.-]{1,80})(?:\/([a-z]+))?$/.exec(path);
      if (mm) {
        const [, id, sub] = mm;
        if (!sub && m === "GET") { json(res, 200, sessions.view(id)); return true; }
        if (!sub && m === "DELETE") { json(res, 200, sessions.close(id)); return true; }
        if (sub === "items" && m === "GET") { json(res, 200, { items: sessions.items(id, Number(u.searchParams.get("since") ?? 0) || 0) }); return true; }
        if (sub === "events" && m === "GET") { sessions.view(id); stream(req, res, id); return true; }
        if (sub === "messages" && m === "POST") { const b = await readBody(req); json(res, 200, await sessions.send(id, String(b.text ?? ""), { wait: b.wait === true, timeoutMs: Number(b.timeoutMs) || undefined })); return true; }
        if (sub === "interrupt" && m === "POST") { json(res, 200, sessions.interrupt(id)); return true; }
        if (sub === "mode" && m === "POST") { const b = await readBody(req); json(res, 200, sessions.setMode(id, b.mode)); return true; }
        if (sub === "dialog" && m === "POST") { const b = await readBody(req); json(res, 200, sessions.answer(id, Number(b.id), b.value === undefined ? null : b.value)); return true; }
        if (sub === "commands" && m === "POST") { const b = await readBody(req); json(res, 200, { lines: await sessions.command(id, String(b.command ?? "")) }); return true; }
      }
      json(res, 404, { error: `no route ${m} ${path} (GET /v1/openapi.json lists them)` }); return true;
    } catch (e) { json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message }); return true; }
  };
  return { handler, close: () => { clearInterval(ping); for (const s of streams) s.end(); streams.clear(); } };
}
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** OpenAPI 3.1 description of /v1 (served at /v1/openapi.json; generate clients from it). */
export const OPENAPI = (version: string) => {
  const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
  const ok = (schema: object, d = "OK") => ({ description: d, content: { "application/json": { schema } } });
  const body = (props: Record<string, object>, required: string[] = []) => ({ required: required.length > 0, content: { "application/json": { schema: { type: "object", properties: props, required } } } });
  const id = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
  return {
    openapi: "3.1.0",
    info: { title: "Amness API", version, description: "Drive Amness sessions over HTTP: start a session, send messages, stream events, answer approvals. Every route except /v1/health and /v1/openapi.json needs the token: Authorization: Bearer <token> (`amness serve token`)." },
    security: [{ bearer: [] }],
    paths: {
      "/v1/health": { get: { security: [], summary: "Is the server up", responses: { 200: ok({ type: "object", properties: { ok: { type: "boolean" }, version: { type: "string" }, sessions: { type: "integer" } } }) } } },
      "/v1/sessions": {
        get: { summary: "Open sessions; with ?saved=<folder> also the conversations saved there", parameters: [{ name: "saved", in: "query", schema: { type: "string" } }], responses: { 200: ok({ type: "object", properties: { open: { type: "array", items: ref("Session") }, saved: { type: "array", items: { type: "object" } } } }) } },
        post: { summary: "Start a session (a new conversation, or resume a saved one)", requestBody: body({ cwd: { type: "string", description: "folder (under the server's --root)" }, resume: { type: "string", description: "id of a saved conversation" }, model: { type: "string", description: "an id, provider:model or server:<name>" }, mode: { enum: MODES }, title: { type: "string" } }), responses: { 201: ok(ref("Session"), "Started") } },
      },
      "/v1/sessions/{id}": { parameters: id, get: { summary: "A session's state, including the dialog it waits for", responses: { 200: ok(ref("Session")) } }, delete: { summary: "Close it (the conversation stays saved)", responses: { 200: ok({ type: "object" }) } } },
      "/v1/sessions/{id}/messages": { parameters: id, post: { summary: "Send a message (or /command, !shell, #note). wait: true answers when the turn ends or a dialog opens", requestBody: body({ text: { type: "string" }, wait: { type: "boolean" }, timeoutMs: { type: "integer" } }, ["text"]), responses: { 200: ok({ type: "object", properties: { accepted: { type: "boolean" }, session: ref("Session"), text: { type: "string", description: "the answer (with wait, when the turn ended)" } } }) } } },
      "/v1/sessions/{id}/items": { parameters: id, get: { summary: "The transcript: messages, tool calls, thinking, notices", parameters: [{ name: "since", in: "query", schema: { type: "integer" }, description: "only items with a larger id" }], responses: { 200: ok({ type: "object", properties: { items: { type: "array", items: ref("Item") } } }) } } },
      "/v1/sessions/{id}/events": { parameters: id, get: { summary: "Server-Sent Events for this session (item, status, dialog, dialogClose, turn.completed, toast, closed)", responses: { 200: { description: "text/event-stream", content: { "text/event-stream": { schema: ref("Event") } } } } } },
      "/v1/events": { get: { summary: "Server-Sent Events for every session", responses: { 200: { description: "text/event-stream", content: { "text/event-stream": { schema: ref("Event") } } } } } },
      "/v1/sessions/{id}/dialog": { parameters: id, post: { summary: "Answer the open approval or question", requestBody: body({ id: { type: "integer", description: "the dialog's id" }, value: { description: "option or item index (choice, pick), text (input), or null to cancel", oneOf: [{ type: "integer" }, { type: "string" }, { type: "null" }] } }, ["id"]), responses: { 200: ok({ type: "object" }), 409: { description: "that dialog is not open" } } } },
      "/v1/sessions/{id}/interrupt": { parameters: id, post: { summary: "Stop the current turn after its step", responses: { 200: ok(ref("Session")) } } },
      "/v1/sessions/{id}/mode": { parameters: id, post: { summary: "Permission mode", requestBody: body({ mode: { enum: MODES } }, ["mode"]), responses: { 200: ok(ref("Session")) } } },
      "/v1/sessions/{id}/commands": { parameters: id, post: { summary: "Run a slash command and get what it printed (not added to the transcript)", requestBody: body({ command: { type: "string", examples: ["/status", "/diff", "/mcp"] } }, ["command"]), responses: { 200: ok({ type: "object", properties: { lines: { type: "array", items: { type: "string" } } } }) } } },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Session: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, cwd: { type: "string" }, project: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, mode: { enum: MODES }, ready: { type: "boolean" }, status: { enum: ["idle", "running", "waiting"] }, turns: { type: "integer" }, queued: { type: "integer" }, createdAt: { type: "integer" }, usage: { type: "object" }, dialog: ref("Dialog"), lastAnswer: { type: "string" } } },
        Dialog: { type: "object", description: "An approval or a question. kind choice: answer with an option index; pick: an item index; input/longtext: text; text: null.", properties: { id: { type: "integer" }, kind: { enum: ["choice", "pick", "input", "text", "longtext"] }, title: { type: "string" }, question: { type: "string" }, body: { type: "array", items: { type: "string" } }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, hint: { type: "string" } } } }, items: { type: "array" }, prompt: { type: "string" } } },
        Item: { type: "object", description: "A transcript block. kind: user, assistant, tool (name, args, status, result), thinking, notice, summary, raw (command output, may contain ANSI colours).", properties: { id: { type: "integer" }, kind: { enum: ["user", "assistant", "tool", "thinking", "notice", "summary", "raw"] }, text: { type: "string" } }, required: ["id", "kind"] },
        Event: { type: "object", properties: { type: { enum: ["item", "status", "dialog", "dialogClose", "turn.completed", "toast", "closed"] }, session: { type: "string" } } },
      },
    },
  };
};

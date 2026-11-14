// A fake MCP server over HTTP for tests. Modes:
//   modern   2026-07-28 Streamable HTTP: no sessions, server/discover, checks MCP-Protocol-Version, Mcp-Method, Mcp-Name and Mcp-Param-* against the body (HeaderMismatch -32020)
//   legacy   2025-11-25 Streamable HTTP: initialize hands out an Mcp-Session-Id that later requests must send; GET/DELETE as before
//   sse      2024-11-05 HTTP+SSE: GET opens the event stream (first event: endpoint), POSTs are answered on the stream
// `stream: true` answers modern requests as an SSE stream (a progress notification, then the result). `auth` requires that bearer token.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeHttpMcp = { url: string; close: () => Promise<void>; seen: { method: string; headers: Record<string, string | string[] | undefined> }[] };
const TOOLS = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" }, region: { type: "string", "x-mcp-header": "Region" } } }, annotations: { readOnlyHint: true } },
  { name: "wipe", description: "Delete everything", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "bad_header", description: "A tool with an invalid x-mcp-header (on a number)", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } },
];

export async function fakeHttpMcp(o: { mode: "modern" | "legacy" | "sse"; stream?: boolean; auth?: string } = { mode: "modern" }): Promise<FakeHttpMcp> {
  const seen: FakeHttpMcp["seen"] = [], sessions = new Set<string>(); let sseRes: ServerResponse | undefined;
  const body = (req: IncomingMessage) => new Promise<string>((res) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => res(s)); });
  const answer = (m: any): any => {
    const p = m.params ?? {};
    if (m.method === "server/discover") return o.mode === "modern" ? { result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-http", version: "2" } } } } : { error: { code: -32601, message: "Method not found" } };
    if (m.method === "initialize") return { result: { protocolVersion: o.mode === "sse" ? "2024-11-05" : "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: `fake-${o.mode}`, version: "1" } } };
    if (m.method === "tools/list") return { result: { resultType: "complete", tools: TOOLS, ttlMs: 60000, cacheScope: "private" } };
    if (m.method === "tools/call") {
      if (p.name === "echo") return { result: { resultType: "complete", content: [{ type: "text", text: `echo:${p.arguments?.text}${p.arguments?.region ? `@${p.arguments.region}` : ""}` }] } };
      return { result: { resultType: "complete", isError: true, content: [{ type: "text", text: "nope" }] } };
    }
    return { error: { code: -32601, message: `unknown ${m.method}` } };
  };
  const server = createServer(async (req, res) => {
    seen.push({ method: req.method!, headers: req.headers });
    if (o.auth && req.headers.authorization !== `Bearer ${o.auth}`) { res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource"` }); return res.end(); }
    if (o.mode === "sse") {
      if (req.method === "GET") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: endpoint\ndata: /messages?sid=1\n\n`); sseRes = res; return; }
      const m = JSON.parse(await body(req)); res.writeHead(202); res.end();
      if (m.id !== undefined && !m.method) return;                                                          // our answer to a server request
      if (m.id !== undefined) sseRes?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, ...answer(m) })}\n\n`);
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") { if (o.mode === "legacy" && req.method === "DELETE") { sessions.delete(String(req.headers["mcp-session-id"])); res.writeHead(200); return res.end(); } res.writeHead(405); return res.end(); }
    const m = JSON.parse(await body(req));
    if (o.mode === "legacy") {
      if (m.method !== "initialize" && !sessions.has(String(req.headers["mcp-session-id"]))) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } })); }
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      const a = answer(m), h: Record<string, string> = { "content-type": "application/json" };
      if (m.method === "initialize") { const sid = `s${sessions.size + 1}`; sessions.add(sid); h["mcp-session-id"] = sid; }
      if (m.method === "server/discover") { res.writeHead(404, h); return res.end(""); }                    // a legacy server has no such method: a bare 404
      res.writeHead(200, h); return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...a }));
    }
    // modern: the header rules of 2026-07-28
    const mismatch = (msg: string) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32020, message: `Header mismatch: ${msg}` } })); };
    const v = req.headers["mcp-protocol-version"], meta = m.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (m.method === "initialize") { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } })); }
    if (v !== "2026-07-28" || meta !== v) return mismatch(`MCP-Protocol-Version ${v} vs _meta ${meta}`);
    if (req.headers["mcp-method"] !== m.method) return mismatch(`Mcp-Method ${req.headers["mcp-method"]} vs ${m.method}`);
    if (m.method === "tools/call") {
      if (req.headers["mcp-name"] !== m.params.name) return mismatch(`Mcp-Name ${req.headers["mcp-name"]} vs ${m.params.name}`);
      const region = m.params.arguments?.region; if ((req.headers["mcp-param-region"] ?? undefined) !== (region ?? undefined)) return mismatch(`Mcp-Param-Region ${req.headers["mcp-param-region"]} vs ${region}`);
    }
    if (req.headers["mcp-session-id"]) return mismatch("sessions are gone in 2026-07-28");
    const a = answer(m);
    if (o.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
      res.write(`: keep-alive\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, ...a })}\n\n`); return res.end();
    }
    res.writeHead(a.error ? (a.error.code === -32601 ? 404 : 400) : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...a }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, close: () => new Promise<void>((r) => { sseRes?.end(); server.closeAllConnections(); server.close(() => r()); }) };
}

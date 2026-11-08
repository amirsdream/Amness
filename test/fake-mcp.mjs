// Minimal MCP stdio server for tests: tools `echo` (read-only) and `wipe` (destructive), newline-delimited JSON-RPC.
// MODE=modern behaves like a 2026-07-28 server: it answers server/discover, needs the per-request _meta on every request, and rejects initialize.
// INPUT=1 makes tools/call ask for input (resultType input_required).
import { createInterface } from "node:readline";
const tools = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "wipe", description: "Delete everything", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  ...Array.from({ length: Number(process.env.EXTRA ?? 0) }, (_, i) => ({ name: `extra${i}`, description: `filler tool ${i} about widgets`, inputSchema: { type: "object" } })),
];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const modern = process.env.MODE === "modern", V = "io.modelcontextprotocol/protocolVersion";
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (modern) {
    const meta = m.params?._meta ?? {};
    if (m.method === "initialize") return send({ id: m.id, error: { code: -32601, message: "initialize is not supported; this server speaks 2026-07-28" } });
    if (!meta[V] || !meta["io.modelcontextprotocol/clientCapabilities"]) return send({ id: m.id, error: { code: -32602, message: "missing _meta" } });
    if (meta[V] !== "2026-07-28") return send({ id: m.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28"], requested: meta[V] } } });
    if (m.method === "server/discover") return send({ id: m.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-modern", version: "1" } } } });
    if (m.method === "tools/call" && process.env.INPUT) return send({ id: m.id, result: { resultType: "input_required", inputRequests: {} } });
  } else if (m.method === "server/discover") return send({ id: m.id, error: { code: -32601, message: "Method not found" } });
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ id: m.id, result: { tools: m.params?.cursor ? tools.slice(2) : tools.slice(0, 2), ...(m.params?.cursor ? {} : { nextCursor: "p2" }) } });
  else if (m.method === "tools/call") {
    if (m.params.name === "echo") send({ id: m.id, result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] } });
    else send({ id: m.id, result: { isError: true, content: [{ type: "text", text: "nope" }] } });
  }
});

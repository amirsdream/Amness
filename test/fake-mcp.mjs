// Minimal MCP stdio server for tests: tools `echo` (read-only) and `wipe` (destructive), newline-delimited JSON-RPC.
import { createInterface } from "node:readline";
const tools = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "wipe", description: "Delete everything", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  ...Array.from({ length: Number(process.env.EXTRA ?? 0) }, (_, i) => ({ name: `extra${i}`, description: `filler tool ${i} about widgets`, inputSchema: { type: "object" } })),
];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ id: m.id, result: { tools: m.params?.cursor ? tools.slice(2) : tools.slice(0, 2), ...(m.params?.cursor ? {} : { nextCursor: "p2" }) } });
  else if (m.method === "tools/call") {
    if (m.params.name === "echo") send({ id: m.id, result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] } });
    else send({ id: m.id, result: { isError: true, content: [{ type: "text", text: "nope" }] } });
  }
});

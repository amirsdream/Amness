import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { onAdapterWarning, openai } from "../src/index.ts";

test("a response schema from the profile is never sent together with tools to a local server; once, with a warning", async () => {
  const bodies: any[] = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { bodies.push(JSON.parse(b)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const warnings: string[] = []; onAdapterWarning((m) => warnings.push(m));
  try {
    const m = openai({ model: "qwen", baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1`, api: "chat" });
    const request = { response_format: { type: "json_schema", json_schema: { name: "x", schema: {} } }, guided_json: {}, temperature: 0.6 };
    const tool = [{ name: "read", description: "", parameters: { type: "object" as const } }];
    await m([{ role: "user", content: "hi" }], tool, { request }); await m([{ role: "user", content: "hi" }], tool, { request });
    await m([{ role: "user", content: "hi" }], [], { request });
    assert.equal(bodies[0].response_format, undefined); assert.equal(bodies[0].guided_json, undefined); assert.equal(bodies[0].temperature, 0.6); assert.ok(bodies[0].tools);
    assert.ok(bodies[2].response_format, "without tools the schema is sent");
    assert.equal(warnings.length, 1); assert.match(warnings[0], /response_format, guided_json/);
  } finally { srv.close(); onAdapterWarning((m) => console.error(m)); }
});

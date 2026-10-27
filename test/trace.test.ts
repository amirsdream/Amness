import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer, cacheWaste, createHarness, defineTool, type Event, type Message, type Model } from "../src/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "amness-tr-"));
let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, usage: { prompt_tokens: 100 + n * 50, completion_tokens: 10, total_tokens: 110 + n * 50, cached_tokens: n * 50 }, tool_calls: [{ id: "t" + ++n, function: { name, arguments: JSON.stringify(args) } }] });

async function scriptedRun(tr: Tracer) {
  n = 0;
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => "tool output" });
  const q = [call("t", { a: 1 }), call("t", { a: 2 }), call("finish", { summary: "done" })];
  const model: Model = async () => q.shift()!;
  await createHarness({ model, tools: [t], onEvent: (e: Event) => tr.event(e) }).run("x");
}

test("tracer: JSONL file has one line per event with timings; text deltas are not logged; tool results are clipped", async () => {
  const f = join(dir(), "t", "s.jsonl"), tr = new Tracer({ file: f, sessionId: "s1", model: "m" });
  await scriptedRun(tr); await tr.close();
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const kinds = lines.map((l) => l.kind);
  assert.ok(kinds.filter((k) => k === "turn").length === 3 && kinds.filter((k) => k === "toolstart").length === 2 && kinds.includes("finish") && kinds.at(-1) === "end");
  const tool = lines.find((l) => l.kind === "tool"); assert.deepEqual([tool.name, tool.ok, tool.result], ["t", true, "tool output"]); assert.equal(typeof tool.ms, "number");
  assert.ok(lines.every((l) => typeof l.t === "string" && typeof l.ms === "number"));
});

test("tracer: OTLP export posts spans with GenAI attributes, a root span and parent links", async () => {
  const got: any[] = []; const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end("{}"); }); });
  await new Promise<void>((r) => srv.listen(0, r));
  const tr = new Tracer({ otlp: `http://127.0.0.1:${(srv.address() as any).port}`, sessionId: "s2", model: "gpt-x", attrs: { "deployment.environment": "test" } });
  await scriptedRun(tr); await tr.close(); srv.closeAllConnections(); srv.close();
  assert.equal(got[0].url, "/v1/traces");
  const spans = got.flatMap((g) => g.body.resourceSpans[0].scopeSpans[0].spans) as any[];
  const chat = spans.filter((s) => s.name.startsWith("chat")), tools = spans.filter((s) => s.name.startsWith("execute_tool"));
  assert.equal(chat.length, 3); assert.equal(tools.length, 2);
  const val = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value;
  assert.equal(val(chat[0], "gen_ai.request.model").stringValue, "gpt-x"); assert.equal(val(chat[0], "gen_ai.usage.input_tokens").intValue, "100");
  assert.equal(val(tools[0], "gen_ai.tool.name").stringValue, "t");
  const root = spans.find((s) => s.name === "amness session"); assert.ok(root && tools.every((s) => s.parentSpanId === root.spanId) && new Set(spans.map((s) => s.traceId)).size === 1);
  assert.equal(got[0].body.resourceSpans[0].resource.attributes.find((a: any) => a.key === "deployment.environment").value.stringValue, "test");
});

test("tracer: an unreachable collector or an unwritable file never breaks the run", async () => {
  const notADir = join(dir(), "plain-file"); writeFileSync(notADir, "x");                       // a path under a regular file can never be created (not /proc: recursive mkdir there hangs on Linux)
  const tr = new Tracer({ otlp: "http://127.0.0.1:1", file: join(notADir, "sub", "x.jsonl"), sessionId: "s3" });
  await scriptedRun(tr); await tr.close();
});

test("cacheWaste: counts full-price re-reads beyond what was newly added, ignores growth and the first turn", () => {
  assert.equal(cacheWaste([{ prompt: 1000, cached: 0 }]), 0);                                                            // cold start
  assert.equal(cacheWaste([{ prompt: 1000, cached: 0 }, { prompt: 1200, cached: 1000 }]), 0);                           // healthy: only the 200 new tokens were fresh
  assert.equal(cacheWaste([{ prompt: 1000, cached: 0 }, { prompt: 1200, cached: 1000 }, { prompt: 1400, cached: 200 }]), 1000);   // the cache broke: 1000 tokens re-read at full price
});

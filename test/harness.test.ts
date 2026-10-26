import { test } from "node:test";
import assert from "node:assert/strict";
import { type Schema, createHarness, defineTool, compact, clip, type Message, type Model, type Event } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({
  role: "assistant", content: null,
  tool_calls: [{ id: `c${++n}`, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
});
const say = (content: string): Message => ({ role: "assistant", content });
const scripted = (...replies: Message[]) => {
  const seen: Message[][] = [];
  const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return replies.shift()!; };
  return { model, seen };
};
const toolMsgs = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);
const add = defineTool<{ a: number; b: number }>({
  name: "add", description: "add", run: ({ a, b }) => a + b,
  schema: { type: "object", required: ["a", "b"], additionalProperties: false, properties: { a: { type: "number" }, b: { type: "number" } } },
});

test("bad tool args are fed back and the model repairs them", async () => {
  const { model, seen } = scripted(call("add", "{oops"), call("add", { a: 1 }), call("add", { a: "1", b: 2 }), call("add", { a: 1, b: 2 }), call("finish", { summary: "3" }));
  const r = await createHarness({ model, tools: [add] }).run("t");
  assert.equal(r.text, "3");
  const t = toolMsgs(seen);
  assert.match(t[0], /not valid JSON/); assert.match(t[1], /\.b: required/); assert.match(t[2], /expected number/); assert.equal(t[3], "3");
});

test("unknown tool lists available ones", async () => {
  const { model, seen } = scripted(call("nope", {}), call("finish", { summary: "x" }));
  await createHarness({ model, tools: [add] }).run("t");
  assert.match(toolMsgs(seen)[0], /Available: add, finish/);
});

test("verify gate rejects false success until it passes", async () => {
  const { model, seen } = scripted(call("finish", { summary: "done" }), call("finish", { summary: "really done" }));
  let ok = false; const events: Event[] = [];
  const r = await createHarness({ model, onEvent: (e) => events.push(e), verify: (s) => (ok ? true : ((ok = true), "tests fail")) }).run("t");
  assert.equal(r.text, "really done"); assert.match(toolMsgs(seen)[0], /REJECTED: tests fail/);
  assert.ok(events.some((e) => e.kind === "rejected"));
});

test("intent without action is nudged; plain answer accepted", async () => {
  const a = scripted(say("Let me fix that now."), call("finish", { summary: "ok" }));
  assert.equal((await createHarness({ model: a.model }).run("t")).text, "ok");
  assert.match(a.seen[1].at(-1)!.content!, /Do it now/);
  const b = await createHarness({ model: scripted(say("The answer is 4.")).model }).run("t");
  assert.deepEqual([b.text, b.finished], ["The answer is 4.", false]);
});

test("repeated identical calls are refused", async () => {
  const same = () => call("add", { a: 1, b: 1 });
  const { model, seen } = scripted(same(), same(), same(), call("finish", { summary: "ok" }));
  await createHarness({ model, tools: [add] }).run("t");
  assert.match(toolMsgs(seen)[2], /exact call 3 times/);
});

test("tool exceptions become errors, not crashes", async () => {
  const boom = defineTool({ name: "boom", description: "", schema: { type: "object" }, run: () => { throw new Error("kaput"); } });
  const { model, seen } = scripted(call("boom", {}), call("finish", { summary: "ok" }));
  await createHarness({ model, tools: [boom] }).run("t");
  assert.equal(toolMsgs(seen)[0], "ERROR: kaput");
});

test("extract repairs fenced/invalid JSON via validation feedback", async () => {
  const schema: Schema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
  const { model, seen } = scripted(say("Sure! ```json\n{\"n\": \"x\"}\n```"), say("{\"n\": 7}"));
  const v = await createHarness({ model }).extract<{ n: number }>("t", schema);
  assert.equal(v.n, 7); assert.match(seen[1].at(-1)!.content!, /\$\.n: expected integer/);
  await assert.rejects(createHarness({ model: scripted(say("no"), say("no"), say("no")).model }).extract("t", schema), /extract failed/);
});

test("compact elides old tool output, keeps recent; clip trims", () => {
  const msgs: Message[] = Array.from({ length: 20 }, () => ({ role: "tool", content: "x".repeat(5000) }));
  compact(msgs, 20_000);
  assert.match(msgs[0].content!, /elided/); assert.equal(msgs.at(-1)!.content!.length, 5000);
  assert.ok(clip("y".repeat(1e5)).length < 7000);
});

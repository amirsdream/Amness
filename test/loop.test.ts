import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, supersede, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({ role: "assistant", content: null, usage: { total_tokens: 10 }, tool_calls: cs.map(([name, a]) => ({ id: `l${++n}`, function: { name, arguments: JSON.stringify(a) } })) });
const scripted = (...replies: Message[]) => { const seen: Message[][] = []; const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return replies.shift() ?? call(["finish", { summary: "." }]); }; return { model, seen }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const obj = { type: "object" } as const;

test("scheduler: read-only calls overlap (capped at 5), writers run alone and in order", async () => {
  let active = 0, peak = 0; const order: string[] = [];
  const read = defineTool({ name: "r", description: "", schema: obj, readOnly: true, run: async () => { peak = Math.max(peak, ++active); await sleep(15); active--; return "r"; } });
  const write = defineTool({ name: "w", description: "", schema: obj, run: async (a: any) => { assert.equal(active, 0); order.push("w" + a.i); await sleep(5); return "w"; } });
  const { model } = scripted(call(...Array.from({ length: 8 }, (_, i): [string, unknown] => ["r", { i }]), ["w", { i: 1 }], ["w", { i: 2 }]), call(["finish", { summary: "." }]));
  const r = await createHarness({ model, tools: [read, write] }).run("x");
  assert.ok(r.finished); assert.equal(peak, 5); assert.deepEqual(order, ["w1", "w2"]);
  const toolMsgs = r.messages.filter((m) => m.role === "tool"); assert.equal(toolMsgs.length, 11);
});

test("scheduler: tools that are neither readOnly nor parallel never overlap", async () => {
  let active = 0, peak = 0;
  const w = defineTool({ name: "w", description: "", schema: obj, run: async () => { peak = Math.max(peak, ++active); await sleep(10); active--; return "ok"; } });
  const { model } = scripted(call(["w", {}], ["w", {}], ["w", {}]));
  await createHarness({ model, tools: [w] }).run("x"); assert.equal(peak, 1);
});

test("stuck: reflection after 3 failing turns, hard stop after 6", async () => {
  const bad = defineTool({ name: "bad", description: "", schema: obj, run: () => { throw new Error("nope"); } });
  const { model, seen } = scripted(...Array.from({ length: 10 }, (_, i) => call(["bad", { i }])));
  const r = await createHarness({ model, tools: [bad], maxSteps: 20 }).run("x");
  assert.equal(r.stopped, "stuck"); assert.equal(r.steps, 6);
  assert.ok(seen.at(-1)!.some((m) => m.role === "user" && /reflect/.test(m.content ?? "")));
});

test("stuck: one success resets the streak", async () => {
  const bad = defineTool({ name: "bad", description: "", schema: obj, run: () => { throw new Error("nope"); } });
  const ok = defineTool({ name: "ok", description: "", schema: obj, run: () => "fine" });
  const { model } = scripted(...[0, 1, 2, 3].map((i) => call(["bad", { i }])).slice(0, 2), call(["ok", {}]), ...[5, 6].map((i) => call(["bad", { i }])), call(["finish", { summary: "." }]));
  const r = await createHarness({ model, tools: [bad, ok] }).run("x"); assert.ok(r.finished);
});

test("wrap-up warning appears 3 steps before the cap", async () => {
  const noop = defineTool({ name: "noop", description: "", schema: obj, run: () => "ok" });
  const { model, seen } = scripted(...Array.from({ length: 12 }, (_, i) => call(["noop", { i }])));
  const r = await createHarness({ model, tools: [noop], maxSteps: 8 }).run("x");
  assert.equal(r.stopped, "maxSteps"); assert.ok(seen.at(-1)!.some((m) => /3 steps left/.test(m.content ?? "")));
});

test("supersede: an older identical call's output is dropped, the newest stays", () => {
  const big = "x".repeat(500);
  const msgs: Message[] = [
    { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "read_file", arguments: '{"path":"f"}' } }] }, { role: "tool", tool_call_id: "a", content: big },
    { role: "assistant", content: null, tool_calls: [{ id: "b", function: { name: "read_file", arguments: '{"path":"f"}' } }] }, { role: "tool", tool_call_id: "b", content: big },
    ...Array.from({ length: 6 }, () => ({ role: "user", content: "pad" }) as Message),
  ];
  supersede(msgs);
  assert.match(msgs[1].content!, /superseded/); assert.equal(msgs[3].content, big);
});

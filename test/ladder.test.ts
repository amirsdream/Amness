import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, ladderDecide, ladderModel, RiskMeter, buildPacket, routedModel, withCard, type Event, type LadderState, type Message, type Model } from "../src/index.ts";

const S = (o: Partial<LadderState>): LadderState => ({ score: 0, cleanTurns: 0, index: 0, start: 0, top: 2, step: 3, tried: new Set(), readOnlyStreak: 0, ...o });
test("ladderDecide: nothing while risk is low; reflect, then replan, then escalate; step down after a clean mechanical stretch; never on step 0", () => {
  assert.equal(ladderDecide(S({ score: 2 })).action, "none");
  assert.equal(ladderDecide(S({ score: 6 })).action, "reflect");
  assert.equal(ladderDecide(S({ score: 10, tried: new Set(["reflect"]) })).action, "replan");
  assert.equal(ladderDecide(S({ score: 14, tried: new Set(["reflect"]) })).action, "replan", "replan before escalate");
  assert.equal(ladderDecide(S({ score: 14, tried: new Set(["reflect", "replan"]) })).action, "escalate");
  assert.equal(ladderDecide(S({ score: 14, tried: new Set(["reflect", "replan"]), index: 2 })).action, "none", "no tier above the top");
  assert.equal(ladderDecide(S({ index: 1, cleanTurns: 4, readOnlyStreak: 2 })).action, "down");
  assert.equal(ladderDecide(S({ index: 1, start: 1, cleanTurns: 9, readOnlyStreak: 5 })).action, "none", "never below the start tier");
  assert.equal(ladderDecide(S({ score: 99, step: 0 })).action, "none");
});

test("RiskMeter: failures and rejected finishes raise the risk; a passing test run and clean turns lower it", () => {
  const r = new RiskMeter(), tool = (name: string, result: string, args = "{}"): Event => ({ kind: "tool", name, args, result });
  r.observe(tool("edit_file", "ERROR: old text not found")); r.observe({ kind: "rejected", detail: "x" }); r.observe({ kind: "loop", detail: "x" }); r.endTurn();
  assert.equal(r.score, 8); assert.equal(r.cleanTurns, 0);
  r.observe(tool("sh", "exit=0\nok", '{"cmd":"npm test"}')); assert.equal(r.score, 4);
  r.endTurn(); assert.equal(r.score, 3); assert.equal(r.cleanTurns, 1);
  r.observe({ kind: "repair", detail: "fixed", fixed: true }); assert.equal(r.score, 3, "a corrected call is not trouble");
});

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `l${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
test("the ladder in the loop: a cheap model that keeps failing gets a reflection, a fresh start, then the next tier, which starts from a note", async () => {
  const boom = defineTool({ name: "boom", description: "", schema: { type: "object" }, run: () => { throw new Error("nope"); } });
  const fine = defineTool({ name: "fine", description: "", readOnly: true, schema: { type: "object", properties: { k: { type: "number" } } }, run: () => "ok" });
  const who: string[] = [], seenByStrong: Message[][] = [];
  let k = 0;
  const cheap = withCard(async (m: Message[]) => { who.push("cheap"); if (m.at(-1)?.content?.startsWith("Your context is about to be reset")) return { role: "assistant", content: "GOAL: x\nNEXT: y" }; return call("boom", { k: k++ }); }, { id: "qwen", tier: "local" });
  const strong = withCard(async (m: Message[]) => { who.push("strong"); seenByStrong.push(m); if (m.at(-1)?.content?.startsWith("Your context is about to be reset")) return { role: "assistant", content: "GOAL: x\nNEXT: y" }; return call("finish", { summary: "done by the strong tier" }); }, { id: "opus", tier: "frontier" });
  const lad = ladderModel([{ model: cheap, label: "qwen" }, { model: strong, label: "opus" }]);
  const ev: Event[] = [];
  const r = await createHarness({ model: lad, ladder: lad, tools: [boom, fine], maxSteps: 30, off: ["loop", "stuck", "stagnation"], onEvent: (e) => ev.push(e) }).run("TASK: make it work");
  assert.equal(r.text, "done by the strong tier");
  const acts = ev.filter((e) => e.kind === "ladder").map((e) => (e as any).action);
  assert.deepEqual(acts, ["reflect", "replan", "escalate"]);
  assert.match(seenByStrong[0].find((m) => m.role === "user")!.content!, /TASK: make it work/);
  assert.ok(seenByStrong[0].length <= 4, "the strong tier starts from the handoff, not the transcript");
  assert.equal(lad.index, 1);
});

test("a new run starts on the start tier again", async () => {
  const a = withCard(async () => call("finish", { summary: "a" }), { id: "a" }), b = withCard(async () => call("finish", { summary: "b" }), { id: "b" });
  const lad = ladderModel([{ model: a, label: "a" }, { model: b, label: "b" }]); lad.moveTo(1);
  const r = await createHarness({ model: lad, ladder: lad }).run("go");
  assert.equal(r.text, "a");
});

test("buildPacket: a 150k-token transcript gives a packet under its cap, with the user's rules word for word", () => {
  const msgs: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "TASK: fix the parser" }, { role: "user", content: "Never edit tests/. Always use pnpm." }];
  for (let i = 0; i < 300; i++) { const c = call("read_file", { path: `f${i}.ts` }); msgs.push(c, { role: "tool", tool_call_id: c.tool_calls![0].id, content: "x".repeat(2000) }); }
  const p = buildPacket({ messages: msgs, why: "escalated", diff: "d".repeat(100_000) });
  assert.ok(p.length <= 24_000, String(p.length));
  assert.match(p, /Never edit tests\/\./); assert.match(p, /Always use pnpm\./); assert.match(p, /TASK: fix the parser/);
});

test("router (M14): the cheap tier may not start a subagent; its redone proposal reaches the strong model as a note; its tokens are charged", async () => {
  const strongSaw: Message[][] = [];
  const cheap = withCard(async () => ({ ...call("task", { description: "go wide" }), usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }), { id: "haiku", tier: "mid" });
  const strong: Model = async (m) => (strongSaw.push(m), { ...call("read_file", { path: "a" }), usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
  const r = routedModel({ strong, cheap, prices: { strong: { input: 5, output: 25 }, cheap: { input: 0.1, output: 0.5 } } });
  const hist: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
  for (let i = 0; i < 4; i++) { const a = call("read_file", { path: `p${i}` }); hist.push(a, { role: "tool", tool_call_id: a.tool_calls![0].id, content: "x" }); }
  const out = await r(hist, [{ name: "read_file", description: "", parameters: { type: "object" } }]);
  assert.equal(out.tool_calls![0].function.name, "read_file");
  assert.match(strongSaw.at(-1)!.at(-1)!.content!, /a cheaper model suggested this next step[\s\S]*task\(/);
  assert.deepEqual(out.usage?.side, [{ model: "haiku", tier: "mid", prompt: 500, completion: 20, cached: 0 }]);
});

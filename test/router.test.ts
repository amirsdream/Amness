import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, decide, defineTool, routedModel, tailShape, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown = {}): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "q" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
const tool = (id: string, content: string): Message => ({ role: "tool", tool_call_id: id, content });
const prices = { strong: { input: 5, output: 25 }, cheap: { input: 1, output: 5 } };
const ctx = (over: object) => ({ tail: { streak: 0, trouble: false, first: false, steering: false }, promptTokens: 40_000, current: "strong" as const, cheapWarm: false, prices, ...over });

test("tailShape: counts consecutive exploration-only turns, notices failures and steering", () => {
  const sys: Message = { role: "system", content: "s" }, usr: Message = { role: "user", content: "task" };
  const a1 = call("grep"), a2 = call("read_file"), a3 = call("edit_file");
  assert.deepEqual(tailShape([sys, usr]), { streak: 0, trouble: false, first: true, steering: false });
  assert.equal(tailShape([sys, usr, a1, tool(a1.tool_calls![0].id, "x"), a2, tool(a2.tool_calls![0].id, "y")]).streak, 2);
  assert.equal(tailShape([sys, usr, a1, tool(a1.tool_calls![0].id, "x"), a3, tool(a3.tool_calls![0].id, "edited"), a2, tool(a2.tool_calls![0].id, "y")]).streak, 1);       // the edit ended the streak
  assert.equal(tailShape([sys, usr, a1, tool(a1.tool_calls![0].id, "ERROR: no such file")]).trouble, true);
  assert.equal(tailShape([sys, usr, a1, tool(a1.tool_calls![0].id, "ok"), { role: "user", content: "also handle X" }]).steering, true);
  assert.equal(tailShape([sys, usr, a1, tool(a1.tool_calls![0].id, "ok"), { role: "user", content: "REJECTED: tests fail" }]).trouble, true);
});

test("decide: strong for the first step, failures, edits and instructions; cheap only when a long enough exploration streak repays the cold read", () => {
  assert.equal(decide(ctx({ tail: { streak: 0, trouble: false, first: true, steering: false } })).tier, "strong");
  assert.equal(decide(ctx({ tail: { streak: 5, trouble: true, first: false, steering: false } })).tier, "strong");
  assert.equal(decide(ctx({ tail: { streak: 5, trouble: false, first: false, steering: true } })).tier, "strong");
  assert.equal(decide(ctx({ tail: { streak: 0, trouble: false, first: false, steering: false } })).tier, "strong");
  // 5:1 price ratio, cold read costs 1x input once and saves 0.4 per step: needs ~2.5 steps
  const short = decide(ctx({ tail: { streak: 1, trouble: false, first: false, steering: false } })); assert.equal(short.tier, "strong"); assert.match(short.reason, /too short to repay a cold read/);
  const long = decide(ctx({ tail: { streak: 3, trouble: false, first: false, steering: false } })); assert.equal(long.tier, "cheap"); assert.match(long.reason, /repaid/);
  assert.equal(decide(ctx({ tail: { streak: 1, trouble: false, first: false, steering: false }, cheapWarm: true })).tier, "cheap");          // warm cheap cache: no cold read to repay
  assert.equal(decide(ctx({ tail: { streak: 9, trouble: false, first: false, steering: false }, prices: { strong: { input: 1, output: 5 }, cheap: { input: 1, output: 5 } } })).tier, "strong");   // no saving: never switch
  assert.equal(decide(ctx({ tail: { streak: 1, trouble: false, first: false, steering: false }, current: "cheap" })).tier, "cheap");         // already there: stay while exploring
});

test("routedModel: exploration moves to the cheap model after a short streak, an edit it proposes is redone by the strong model, and who answered is reported", async () => {
  const script = (k: number): Message => [call("grep", { pattern: "a" }), call("read_file", { path: "a" }), call("read_file", { path: "b" }), call("read_file", { path: "c" }), call("read_file", { path: "d" }), call("edit_file", { path: "a", old: "x", new: "y" }), call("finish", { summary: "done" })][k];
  const answered: string[] = [], routes: string[] = [];
  const at = (m: Message[]) => m.filter((x) => x.role === "assistant").length;
  const strong: Model = async (m) => (answered.push(`${at(m)}:strong`), script(at(m))), cheap: Model = async (m) => (answered.push(`${at(m)}:cheap`), script(at(m)));
  const mk = (name: string) => defineTool({ name, description: "", schema: { type: "object" }, readOnly: name !== "edit_file", run: () => "ok" });
  const r = await createHarness({ model: routedModel({ strong, cheap, prices, onRoute: (d) => routes.push(`${d.tier}${d.switched ? "*" : ""}`) }), tools: ["grep", "read_file", "edit_file"].map(mk), maxSteps: 12 }).run("go");
  assert.ok(r.finished);
  assert.deepEqual(answered, ["0:strong", "1:strong", "2:cheap", "3:cheap", "4:cheap", "5:cheap", "5:strong", "6:strong"]);         // the cheap model's edit (step 5) was thrown away and redone
  assert.ok(routes.includes("cheap*") && routes.includes("strong*"));
  assert.equal(r.messages.filter((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "edit_file")).length, 1);
});

test("routedModel: reasoning blobs from the other tier are not sent along; a text-only cheap answer is redone by the strong model", async () => {
  const seenRaw: (unknown[])[] = [];
  const cheap: Model = async (m) => (seenRaw.push(m.filter((x) => x.role === "assistant").map((x) => x.raw)), { role: "assistant", content: "I think we are done" });
  const strong: Model = async (m) => { const k = m.filter((x) => x.role === "assistant").length; return k < 3 ? { ...call("read_file"), raw: { from: "strong", k } } : { role: "assistant", content: "final answer", raw: { from: "strong" } }; };
  const model = routedModel({ strong, cheap, prices, now: () => 0 });
  const sys: Message = { role: "system", content: "s" }, usr: Message = { role: "user", content: "t" };
  const a1 = { ...call("read_file"), raw: { from: "strong", k: 0 } }, a2 = { ...call("read_file"), raw: { from: "strong", k: 1 } }, a3 = { ...call("read_file"), raw: { from: "strong", k: 2 } };
  const msgs: Message[] = [sys, usr, a1, tool(a1.tool_calls![0].id, "r"), a2, tool(a2.tool_calls![0].id, "r"), a3, tool(a3.tool_calls![0].id, "r")];
  const r = await model(msgs, []);                                                                     // streak 3 on the strong model: tries cheap, which answers in text, so strong redoes it
  assert.equal(r.content, "final answer"); assert.equal(seenRaw.length, 1); assert.ok(seenRaw[0].every((x) => x === undefined));      // the cheap model never saw the strong model's reasoning blobs
});

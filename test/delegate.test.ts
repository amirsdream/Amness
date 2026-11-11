import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, checkRanges, createCodeAgent, withCard, type Event, type Message, type Model, type ModelOpts } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `g${++n}`, function: { name, arguments: JSON.stringify(args) } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
const repo = () => { const d = mkdtempSync(join(tmpdir(), "amness-del-")); writeFileSync(join(d, "a.ts"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")); return d; };
const agent = (d: string, lead: Message[], explore: Model, extra: object = {}) => createCodeAgent({ model: withCard(async () => lead.shift() ?? { role: "assistant", content: "done" }, { id: "big" }), models: { explore }, cwd: d, memory: false, guidance: false, chat: true, index: false, permissions: { mode: () => "default" }, ...extra });

test("checkRanges keeps ranges that exist, drops the rest, and refuses a result without the format", () => {
  const d = repo();
  const ok = checkRanges(d, "ANSWER: it is in a.ts\nFILES:\n- a.ts:3-9 the loop\n- a.ts:50-60 past the end\n- nope.ts:1-2 missing\n- ../etc/passwd:1-2 outside");
  assert.ok(ok.ok); if (ok.ok) { assert.match(ok.text, /- a\.ts:3-9 the loop/); assert.match(ok.text, /dropped 3 range/); assert.doesNotMatch(ok.text, /^- a\.ts:50/m); }
  assert.deepEqual(checkRanges(d, "It is somewhere in a.ts."), { ok: false, why: "its result did not use the ANSWER / FILES format" });
  assert.equal(checkRanges(d, "ANSWER: x\nFILES:\n- b.ts:1-2 y").ok, false);
});

test("the explorer runs with its own card: a small-window explorer gets the short prompt and compact specs, inside its window", async () => {
  const d = repo(); let sys = "", desc = "";
  const explore = withCard(async (m, specs) => { sys ||= m[0].content ?? ""; desc ||= specs.find((s) => s.name === "read_file")?.description ?? ""; return call("finish", { summary: "a.ts:1" }); }, { id: "qwen-4b", window: () => 8192 });
  await agent(d, [call("task", { description: "where is line 1" })], explore).chat([], "explore");
  assert.match(sys, /^You are a read-only code explorer\. Answer the question in the brief\./);
  assert.ok(desc.length <= 120, `compact read_file description (${desc.length} chars)`);
});

test("takeover: an explorer that does not finish hands the work back plainly, is counted, and after two failures exploration runs on the main model", async () => {
  const d = repo(), ev: Event[] = [];
  const bad = withCard(async () => ({ role: "assistant" as const, content: "" }), { id: "qwen-4b" });
  let mainExplored = 0;
  const lead = [call("task", { description: "q1" }), call("task", { description: "q2" }), call("task", { description: "q3" })];
  const main = withCard(async (m: Message[]) => {
    if ((m[0].content ?? "").includes("read-only code explorer")) { mainExplored++; return call("finish", { summary: "main explored" }); }
    return lead.shift() ?? { role: "assistant", content: "done" };
  }, { id: "big" });
  const a = createCodeAgent({ model: main, models: { explore: bad }, cwd: d, memory: false, guidance: false, chat: true, index: false, permissions: { mode: () => "default" }, onEvent: (e) => ev.push(e) });
  const r = await a.chat([], "go"), outs = r.messages.filter((m) => m.role === "tool").map((m) => m.content!);
  assert.match(outs[0], /^TAKEOVER: the explore on qwen-4b failed/); assert.match(outs[1], /from now on explore runs on the main model/);
  assert.equal(outs[2], "main explored"); assert.equal(mainExplored, 1);
  assert.deepEqual(ev.filter((e) => e.kind === "takeover").map((e) => (e as any).count), [1, 2]);
});

test("exploreRanges: a result with real ranges reaches the parent checked; one without the format is a takeover", async () => {
  const d = repo();
  const good = withCard(async () => call("finish", { summary: "ANSWER: line 5 is the one\nFILES:\n- a.ts:5-5 the line" }), { id: "small" });
  const r1 = await agent(d, [call("task", { description: "q" })], good, { exploreRanges: true }).chat([], "go");
  assert.match(r1.messages.find((m) => m.role === "tool")!.content!, /FILES \(checked/);
  const prose = withCard(async () => call("finish", { summary: "It is near the top of a.ts." }), { id: "small" });
  const r2 = await agent(d, [call("task", { description: "q" })], prose, { exploreRanges: true }).chat([], "go");
  assert.match(r2.messages.find((m) => m.role === "tool")!.content!, /^TAKEOVER: .*ANSWER \/ FILES format/);
});

test("budget tier weights: local-tier tokens count less against the cap; spending is reported per tier", () => {
  const b = new Budget({ maxTokens: 1000, tierWeights: { local: 0.1 } }), m = (t: number): Message => ({ role: "assistant", content: "x", usage: { prompt_tokens: t, completion_tokens: 0, total_tokens: t } });
  b.add(m(2000), { id: "qwen", tier: "local" }); b.add(m(500), { id: "opus", tier: "frontier" });
  assert.equal(b.effective, 700); assert.equal(b.exceeded(), null);
  const s = b.slice(0.5); assert.deepEqual(s.tierWeights, { local: 0.1 });
});

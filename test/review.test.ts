import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, createCodeAgent, proposeContract, reviewWork, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "r" + ++n, function: { name, arguments: JSON.stringify(args) } }], usage: { total_tokens: 10 } });
const say = (c: string): Message => ({ role: "assistant", content: c, usage: { total_tokens: 10 } });
const repo = () => { const d = mkdtempSync(join(tmpdir(), "amness-rv-")); writeFileSync(join(d, "a.js"), "exports.f = () => 1;\n"); return d; };

test("contract: a JSON list of criteria is parsed and capped; junk or errors give no contract", async () => {
  const budget = new Budget();
  assert.deepEqual(await proposeContract(async () => say('["f() returns 2", "the test passes", "no other file changes"]'), "task", budget), ["f() returns 2", "the test passes", "no other file changes"]);
  assert.equal(budget.calls, 1);
  assert.equal((await proposeContract(async () => say(JSON.stringify(Array.from({ length: 20 }, (_, i) => `criterion number ${i}`))), "t")).length, 7);
  assert.deepEqual(await proposeContract(async () => say("I would suggest testing it"), "t"), []);
  assert.deepEqual(await proposeContract(async () => { throw new Error("down"); }, "t"), []);
});

test("review: the verdict comes back as pass/findings; unusable output is inconclusive and never blocks; the reviewer cannot edit or run arbitrary commands", async () => {
  const d = repo(), base = { cwd: d, task: "t", contract: ["f returns 2"], summary: "done", diffs: "", commands: "" };
  const fail = await reviewWork({ ...base, model: async () => call("finish", { summary: '{"pass": false, "findings": ["f still returns 1", "no test"]}' }) });
  assert.deepEqual([fail.pass, fail.findings], [false, ["f still returns 1", "no test"]]);
  assert.equal((await reviewWork({ ...base, model: async () => call("finish", { summary: '{"pass": true, "findings": []}' }) })).pass, true);
  assert.equal((await reviewWork({ ...base, model: async () => call("finish", { summary: '{"pass": true, "findings": ["but this is wrong"]}' }) })).pass, false);   // a finding always fails the review
  assert.equal((await reviewWork({ ...base, model: async () => call("finish", { summary: "looks good to me" }) })).inconclusive, true);
  assert.equal((await reviewWork({ ...base, model: async () => { throw new Error("boom"); } })).inconclusive, true);
  const specs: string[][] = [], outs: string[] = []; const q = [call("run_check", { cmd: "rm -rf a.js" }), call("run_check", { cmd: "node --test x" }), call("finish", { summary: '{"pass":true,"findings":[]}' })];
  await reviewWork({ ...base, model: async (m, s) => (specs.push(s.map((x) => x.name)), outs.push(m.filter((x) => x.role === "tool").at(-1)?.content ?? ""), q.shift()!) });
  assert.ok(!specs[0].includes("write_file") && !specs[0].includes("edit_file") && !specs[0].includes("sh") && specs[0].includes("run_check") && specs[0].includes("read_file"));
  assert.match(outs[1], /only the project's test, build/);                                                           // rm refused
});

test("agent: criteria are shown to the builder, a failed review sends findings back, the fix is re-reviewed, and the reviewer is a separate model", async () => {
  const d = repo(), builderSeen: Message[][] = [], reviewerCalls: string[] = [];
  const builderQ = [call("finish", { summary: "Changed f." }), call("read_file", { path: "a.js" }), call("edit_file", { path: "a.js", old: "=> 1", new: "=> 2" }), call("finish", { summary: "Changed a.js so f returns 2." })];
  const builder: Model = async (m) => (builderSeen.push(m.map((x) => ({ ...x }))), builderQ.shift()!);
  let verdicts = 0;
  const reviewer: Model = async (m) => {
    const sys = m[0].content ?? "";
    if (/acceptance criteria for a coding task/.test(sys)) { reviewerCalls.push("contract"); return say('["f() returns 2", "only a.js changes"]'); }
    reviewerCalls.push("review"); return call("finish", { summary: verdicts++ === 0 ? '{"pass": false, "findings": ["a.js was never changed, so f() still returns 1"]}' : '{"pass": true, "findings": []}' });
  };
  const ev: any[] = [];
  const agent = createCodeAgent({ model: builder, cwd: d, memory: false, guidance: false, chat: true, review: { model: reviewer }, onEvent: (e) => ev.push(e) });
  const r = await agent.chat([], "please fix f so that it returns 2");
  assert.ok(r.finished);
  assert.match(builderSeen[0].find((m) => m.role === "user")!.content!, /Acceptance criteria[\s\S]*1\. f\(\) returns 2[\s\S]*2\. only a\.js changes/);
  assert.match(builderSeen[1].filter((m) => m.role === "tool").at(-1)!.content!, /REJECTED: an independent reviewer found problems:\n- a\.js was never changed/);
  assert.deepEqual(reviewerCalls, ["contract", "review", "review"]);
  assert.deepEqual(ev.filter((e) => e.kind === "review").map((e) => e.pass), [false, true]);
});

test("agent: a plain question gets no contract and no review; the reviewer never blocks more than twice", async () => {
  const d = repo(); let calls = 0;
  const reviewer: Model = async (m) => (calls++, /acceptance criteria for a coding task/.test(m[0].content ?? "") ? say("[]") : call("finish", { summary: '{"pass": false, "findings": ["still wrong"]}' }));
  const a1 = createCodeAgent({ model: async () => say("It returns 1."), cwd: d, memory: false, guidance: false, chat: true, review: { model: reviewer } });
  assert.equal((await a1.chat([], "what does f return?")).finished, false); assert.equal(calls, 0);
  const q = [call("finish", { summary: "done" }), call("finish", { summary: "done" }), call("finish", { summary: "done" })];
  const r = await createCodeAgent({ model: async () => q.shift()!, cwd: d, memory: false, guidance: false, chat: true, review: { model: reviewer } }).chat([], "implement the feature please");
  assert.ok(r.finished && r.steps === 3);
});

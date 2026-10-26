import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, createHarness, defineTool, runShell, type Event, type Message, type Model } from "../src/index.ts";
import { rememberTask } from "../cli/state.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({ role: "assistant", content: null, tool_calls: cs.map(([name, a]) => ({ id: `c${++n}`, function: { name, arguments: JSON.stringify(a) } })) });
const scripted = (...replies: Message[]) => { const seen: Message[][] = []; const model: Model = async (m) => (seen.push(m.map((x) => ({ ...x }))), replies.shift()!); return { model, seen }; };
const tmp = () => mkdtempSync(join(tmpdir(), "amness-u-"));

test("abort between turns: stops at a safe point, history consistent, checkpoint written, resumable", async () => {
  const ac = new AbortController();
  const stopper = defineTool({ name: "stopper", description: "", schema: { type: "object" }, run: () => (ac.abort(), "ok") });
  let saved: Message[] = []; const events: Event[] = [];
  const { model } = scripted(call(["stopper", {}]), call(["finish", { summary: "never" }]));
  const r = await createHarness({ model, tools: [stopper], signal: ac.signal, checkpoint: (m) => (saved = JSON.parse(JSON.stringify(m))), onEvent: (e) => events.push(e) }).run("t");
  assert.deepEqual([r.finished, r.stopped, r.steps], [false, "aborted", 1]);
  assert.equal(r.messages.at(-1)!.role, "tool");                                      // every tool call answered
  assert.equal(saved.length, r.messages.length); assert.ok(events.some((e) => e.kind === "aborted"));
  const b = scripted(call(["finish", { summary: "resumed ok" }]));
  assert.equal((await createHarness({ model: b.model, tools: [stopper] }).run("t", { resume: saved })).text, "resumed ok");
});

test("abort during a model call: the adapter's AbortError becomes a clean stop, not a crash", async () => {
  const ac = new AbortController();
  const model: Model = (_m, _t, o) => new Promise((_ok, bad) => { o!.signal!.addEventListener("abort", () => bad(new DOMException("aborted", "AbortError"))); setTimeout(() => ac.abort(), 5); });
  const r = await createHarness({ model, signal: ac.signal }).run("t");
  assert.equal(r.stopped, "aborted");
  const other = await createHarness({ model: async () => { throw new Error("real failure"); }, signal: new AbortController().signal }).run("t").catch((e) => e.message);
  assert.equal(other, "real failure");                                                 // non-abort errors still surface
});

test("signal can be a getter (fresh controller per round) and reaches shell tools", async () => {
  let ac = new AbortController();
  const t0 = Date.now();
  const p = runShell("sleep 5", tmp(), 10_000, ac.signal);
  setTimeout(() => ac.abort(), 50);
  const out = await p;
  assert.match(out, /^exit=interrupted/); assert.ok(Date.now() - t0 < 3000);
  ac = new AbortController();
  const { model } = scripted(call(["finish", { summary: "ok" }]));
  assert.equal((await createHarness({ model, signal: () => ac.signal }).run("t")).text, "ok");
});

test("followUp continues the same conversation with full context", async () => {
  const dir = tmp();
  const first = scripted(call(["list_files", {}]), call(["finish", { summary: "listed" }]));
  const agent = createCodeAgent({ model: first.model, cwd: dir, memory: false });
  const r = await agent.run("look around");
  const second = scripted(call(["finish", { summary: "did the follow-up" }]));
  const agent2 = createCodeAgent({ model: second.model, cwd: dir, memory: false });
  const r2 = await agent2.followUp(r, "now also check hidden files");
  assert.equal(r2.text, "did the follow-up");
  const sent = second.seen[0];
  assert.equal(sent.length, r.messages.length + 1);                                    // everything before is replayed
  assert.equal(sent.at(-1)!.content, "now also check hidden files"); assert.match(sent[1].content!, /look around/);
});

test("resuming with a new instruction adds it as a follow-up; resuming with the same task does not", async () => {
  const dir = tmp(), cp = join(dir, "cp.json");
  const a = scripted(call(["list_files", {}]));
  await assert.rejects(createCodeAgent({ model: a.model, cwd: dir, memory: false, checkpointFile: cp }).run("original task"));   // crashes on turn 2
  assert.ok(existsSync(cp));
  const same = scripted(call(["finish", { summary: "." }]));
  await createCodeAgent({ model: same.model, cwd: dir, memory: false, checkpointFile: cp }).run("original task", { resume: true });
  assert.equal(same.seen[0].filter((m) => m.role === "user").length, 1);
  const a2 = scripted(call(["list_files", {}]));
  await assert.rejects(createCodeAgent({ model: a2.model, cwd: dir, memory: false, checkpointFile: cp }).run("original task"));
  const diff = scripted(call(["finish", { summary: "." }]));
  await createCodeAgent({ model: diff.model, cwd: dir, memory: false, checkpointFile: cp }).run("also add tests", { resume: true });
  assert.equal(diff.seen[0].at(-1)!.content, "also add tests");
});

test("task history: most recent first, de-duplicated, capped", () => {
  let s = { verifyByDir: {}, tasks: [] as string[] };
  for (const t of ["a", "b", "a", "  ", "c"]) s = rememberTask(s, t);
  assert.deepEqual(s.tasks, ["c", "a", "b"]);
  for (let i = 0; i < 80; i++) s = rememberTask(s, "t" + i);
  assert.equal(s.tasks.length, 50); assert.equal(s.tasks[0], "t79");
});

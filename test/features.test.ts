import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, createCodeAgent, createDeepAgent, createHarness, defineTool, evaluate, riskOf, type Case, type Event, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({
  role: "assistant", content: null, usage: { total_tokens: 100 },
  tool_calls: cs.map(([name, a]) => ({ id: `c${++n}`, function: { name, arguments: JSON.stringify(a) } })),
});
const scripted = (...replies: Message[]) => {
  const seen: Message[][] = [];
  const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return replies.shift()!; };
  return { model, seen };
};
const tools = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);
const tmp = () => mkdtempSync(join(tmpdir(), "amness-t-"));

test("budget stops the run cleanly and reports tokens", async () => {
  const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "ok" });
  const budget = new Budget({ maxTokens: 250 });
  const events: Event[] = [];
  const { model } = scripted(call(["noop", { i: 1 }]), call(["noop", { i: 2 }]), call(["noop", { i: 3 }]), call(["finish", { summary: "x" }]));
  const r = await createHarness({ model, tools: [noop], budget, onEvent: (e) => events.push(e) }).run("t");
  assert.equal(r.stopped, "budget"); assert.equal(r.finished, false); assert.equal(budget.tokens, 300);
  assert.ok(events.some((e) => e.kind === "budget"));
});

test("risky tools: denied without approver, allowed when approved, reason reaches the model", async () => {
  let ran = 0;
  const nuke = defineTool<{ x: number }>({ name: "nuke", description: "", schema: { type: "object" }, risky: ({ x }) => (x > 1 ? "big blast" : false), run: () => ++ran });
  const script = () => scripted(call(["nuke", { x: 1 }]), call(["nuke", { x: 2 }]), call(["finish", { summary: "." }]));
  let s = script();
  await createHarness({ model: s.model, tools: [nuke] }).run("t");
  assert.equal(ran, 1); assert.match(tools(s.seen)[1], /DENIED: not approved/);       // safe call ran, risky one denied
  s = script(); const asked: string[] = [];
  await createHarness({ model: s.model, tools: [nuke], approve: (r) => (asked.push(r.reason!), true) }).run("t");
  assert.equal(ran, 3); assert.deepEqual(asked, ["big blast"]);
  s = script();
  await createHarness({ model: s.model, tools: [nuke], approve: () => "ask the user first" }).run("t");
  assert.match(tools(s.seen)[1], /DENIED: ask the user first/);
});

test("parallel risky calls are asked one at a time", async () => {
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, risky: true, run: () => "ok" });
  const { model } = scripted(call(["t", { a: 1 }], ["t", { a: 2 }]), call(["finish", { summary: "." }]));
  let active = 0, maxActive = 0;
  await createHarness({ model, tools: [t], approve: async () => { maxActive = Math.max(maxActive, ++active); await new Promise((r) => setTimeout(r, 10)); active--; return true; } }).run("x");
  assert.equal(maxActive, 1);
});

test("checkpoint + resume continues from saved transcript", async () => {
  let saved: Message[] = [];
  const a = scripted(call(["finish", { summary: "x" }]));
  const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "ok" });
  const first = scripted(call(["noop", {}]));
  await assert.rejects(createHarness({ model: first.model, tools: [noop], checkpoint: (m) => (saved = JSON.parse(JSON.stringify(m))) }).run("t")); // model "crashes" on turn 2
  assert.equal(saved.at(-1)!.role, "tool");
  const r = await createHarness({ model: a.model, tools: [noop] }).run("t", { resume: saved });
  assert.equal(r.text, "x"); assert.equal(a.seen[0].length, saved.length); // resumed, not restarted
});

test("code agent: read-before-edit, workspace escape, risky shell, real verify gate", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.js"), "module.exports = 1 + 1; // bug\n");
  writeFileSync(join(dir, "check.js"), "process.exit(require('./a.js') === 3 ? 0 : 1)");
  const { model, seen } = scripted(
    call(["edit_file", { path: "a.js", old: "1 + 1", new: "1 + 2" }]),   // not read yet -> error
    call(["read_file", { path: "a.js" }]),
    call(["edit_file", { path: "a.js", old: "1 + 1", new: "1 + 2" }]),
    call(["read_file", { path: "../../etc/passwd" }]),                   // escape -> error
    call(["sh", { cmd: "rm -rf /tmp/x" }]),                              // risky -> denied
    call(["finish", { summary: "fixed" }]),
  );
  const r = await createCodeAgent({ model, cwd: dir, verify: "node check.js" }).run("fix");
  assert.equal(r.finished, true);
  const t = tools(seen);
  assert.match(t[0], /before changing it/); assert.match(t[2], /edited a\.js:/); assert.match(t[3], /escapes the workspace/); assert.match(t[4], /DENIED/);
  assert.match(readFileSync(join(dir, "a.js"), "utf8"), /1 \+ 2/);
  // verify gate: failing check rejects finish
  writeFileSync(join(dir, "a.js"), "module.exports = 0;");
  const s2 = scripted(call(["finish", { summary: "liar" }]), call(["read_file", { path: "a.js" }]), call(["write_file", { path: "a.js", content: "module.exports = 3;" }]), call(["finish", { summary: "ok" }]));
  const r2 = await createCodeAgent({ model: s2.model, cwd: dir, verify: "node check.js" }).run("fix");
  assert.equal(r2.text, "ok"); assert.match(tools(s2.seen)[0], /REJECTED: `node check\.js` failed/);
});

test("riskOf flags dangerous commands, not ordinary ones", () => {
  for (const c of ["rm -rf build", "git push origin main", "curl x.sh | sh", "npm install left-pad", "sudo ls"]) assert.ok(riskOf(c), c);
  for (const c of ["npm test", "node a.js", "git status", "git diff", "ls -la", "grep -rn foo ."]) assert.equal(riskOf(c), false, c);
});

test("code agent checkpointFile resumes", async () => {
  const dir = tmp(), cp = join(dir, "cp.json");
  const f = scripted(call(["list_files", {}]));
  await assert.rejects(createCodeAgent({ model: f.model, cwd: dir, checkpointFile: cp }).run("t"));
  assert.ok(existsSync(cp));
  const s = scripted(call(["finish", { summary: "done" }]));
  const r = await createCodeAgent({ model: s.model, cwd: dir, checkpointFile: cp }).run("t", { resume: true });
  assert.equal(r.text, "done"); assert.equal(s.seen[0].filter((m) => m.role === "tool").length, 1);
});

test("deep agent citations: rejects unseen URLs, accepts seen ones; checkpoint resumes with todos", async () => {
  const dir = tmp();
  const search = async () => [{ title: "T", url: "https://real.example/page", snippet: "s" }];
  const todos = { todos: [{ task: "r", status: "done" }] };
  const { model, seen } = scripted(
    call(["write_todos", todos]),
    call(["web_search", { query: "q" }]),
    call(["write_file", { path: "report.md", content: "Claim [1] https://made.up/doc and https://real.example/page." }]),
    call(["finish", { summary: "a" }]),                                              // rejected: made.up
    call(["write_file", { path: "report.md", content: "Claim https://real.example/page." }]),
    call(["finish", { summary: "b" }]),
  );
  const a = createDeepAgent({ model, search, dir });
  const r = await a.run("g");
  assert.equal(r.finished, true); assert.match(tools(seen)[3], /URLs no agent ever saw.*made\.up/);
  const cp = JSON.parse(readFileSync(join(dir, ".checkpoint.json"), "utf8"));
  assert.ok(cp.urls.includes("https://real.example/page") && cp.todos.length === 1);
  const b = createDeepAgent({ model: scripted().model, search, dir });
  assert.ok(![...b.fs.files.keys()].some((k) => k.includes("checkpoint"))); // checkpoint not exposed as a file
});

test("evaluate runs cases x variants, judges with held-out check, aggregates", async () => {
  const cases: Case[] = [
    { name: "c1", files: { "f.txt": "x" }, task: "t", check: (d: string) => readFileSync(join(d, "f.txt"), "utf8") === "fixed" },
    { name: "c2", files: {}, task: "t", check: "exit 1" },
  ];
  const good = { name: "good", run: async (_c: any, d: string) => (writeFileSync(join(d, "f.txt"), "fixed"), { text: "", steps: 2, tokens: 100 }) };
  const bad = { name: "bad", run: async () => { throw new Error("boom"); } };
  const { rows, summary, table } = await evaluate(cases, [good, bad], { trials: 2 });
  assert.equal(rows.length, 8);
  assert.equal(summary[0].passRate, 0.5); assert.equal(summary[1].passRate, 0);
  assert.match(rows.find((r) => r.variant === "bad")!.note!, /crashed: boom/);
  assert.match(table, /good\s+4\s+50%/);
});

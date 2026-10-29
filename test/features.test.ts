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
  assert.equal(r.stopped, "budget"); assert.equal(r.finished, false); assert.ok(budget.tokens <= 400);
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

test("budget awareness: notes at 50% and 75%+, and a final no-tools report instead of a bare stop", async () => {
  const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "ok" }), budget = new Budget({ maxTokens: 2000 }), events: Event[] = [];
  const replies: Message[] = Array.from({ length: 30 }, (_, i) => call(["noop", { i }]));
  const seen: { n: number; tools: number; msgs: Message[] }[] = [];
  const model: Model = async (msgs, specs) => { seen.push({ n: seen.length, tools: specs.length, msgs: msgs.map((m) => ({ ...m })) }); if (specs.length === 0) return { role: "assistant", content: "Found X; Y is left.", usage: { total_tokens: 100 } }; return { ...replies.shift()!, usage: { total_tokens: 100 } }; };
  const r = await createHarness({ model, tools: [noop], budget, onEvent: (e) => events.push(e), off: ["stagnation", "loop"] }).run("t");
  const notes = seen.at(-1)!.msgs.filter((m) => m.role === "user" && /^Budget: /.test(m.content ?? "")).map((m) => m.content!);
  assert.equal(notes.length, 2); assert.match(notes[0], /50% used/); assert.match(notes[1], /75% used/);
  assert.equal(r.stopped, "budget"); assert.match(r.text, /Found X; Y is left\./); assert.ok(budget.tokens <= 2000, `stayed within the cap, used ${budget.tokens}`);
  assert.equal(seen.at(-1)!.tools, 0);
  const off = await createHarness({ model: scripted(call(["noop", {}]), call(["noop", {}]), call(["noop", {}])).model, tools: [noop], budget: new Budget({ maxTokens: 250 }), off: ["wrapup"] }).run("t");
  assert.equal(off.stopped, "budget"); assert.match(off.text, /^stopped: token budget exhausted/);
});

test("exploration that never closes: after 12 read-only turns the model is told to answer or act", async () => {
  const look = defineTool({ name: "look", description: "", schema: { type: "object" }, readOnly: true, run: ({}: any) => "x" });
  const { model, seen } = scripted(...Array.from({ length: 13 }, (_, i) => call(["look", { i }])), call(["finish", { summary: "done" }]));
  await createHarness({ model, tools: [look], maxSteps: 30, off: ["stagnation", "loop"] }).run("explain it");
  const notes = seen.at(-1)!.filter((m) => m.role === "user" && /only reading/.test(m.content ?? ""));
  assert.equal(notes.length, 1); assert.match(notes[0].content!, /12 turns/);
});

test("the token cap counts cached input at a tenth, so a long cached session is not 'exhausted' early", () => {
  const b = new Budget({ maxTokens: 1000 });
  b.add({ role: "assistant", content: "", usage: { prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100, cached_tokens: 4800 } });
  assert.equal(b.tokens, 5100); assert.equal(Math.round(b.effective), 780); assert.equal(b.exceeded(), null);
});

test("a budget slice is capped to a share of what is left and charges the parent too", () => {
  const b = new Budget({ maxTokens: 1000 }); b.add({ role: "assistant", content: "", usage: { total_tokens: 400 } });
  const s = b.slice(0.5, 250); assert.equal(s.maxTokens, 250); assert.equal(b.slice(0.5).maxTokens, 300);
  s.add({ role: "assistant", content: "", usage: { total_tokens: 100 } }); assert.equal(s.tokens, 100); assert.equal(b.tokens, 500);
  assert.equal(new Budget().slice(0.5).maxTokens, Infinity);
});

test("model-agnostic: a server that reports no usage still gets a working cap, notes and final report (tokens are estimated)", async () => {
  const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "x".repeat(2000) }), budget = new Budget({ maxTokens: 3000 });
  let n = 0; const model: Model = async (_m, specs) => (specs.length === 0 ? { role: "assistant", content: "Summary: looked around." } : call(["noop", { i: n++ }]) && { role: "assistant", content: null, tool_calls: [{ id: "u" + n, function: { name: "noop", arguments: JSON.stringify({ i: n++ }) } }] });
  const r = await createHarness({ model, tools: [noop], budget, maxSteps: 40, off: ["loop", "stagnation"] }).run("t");
  assert.equal(r.stopped, "budget"); assert.match(r.text, /Summary: looked around\./); assert.ok(budget.tokens > 0 && budget.tokens < 6000, `used ${budget.tokens}`);
});

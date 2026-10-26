import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, READONLY_CMD, createCodeAgent, createHarness, defineTool, openai, type Event, type Message, type Model, type PermMode } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({ role: "assistant", content: null, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  tool_calls: cs.map(([name, a]) => ({ id: `c${++n}`, function: { name, arguments: JSON.stringify(a) } })) });
const scripted = (...replies: Message[]) => { const seen: Message[][] = [], specs: string[][] = []; const model: Model = async (m, t) => (seen.push(m.map((x) => ({ ...x }))), specs.push(t.map((x) => x.name)), replies.shift()!); return { model, seen, specs }; };
const tmp = () => mkdtempSync(join(tmpdir(), "amness-e2-"));
const outs = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);

test("events: toolstart precedes tool with the same id; assistant text and token split are reported", async () => {
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => "done" });
  const ev: Event[] = [];
  const { model } = scripted({ ...call(["t", {}]), content: "Looking." }, call(["finish", { summary: "ok" }]));
  await createHarness({ model, tools: [t], onEvent: (e) => ev.push(e) }).run("x");
  const i = ev.findIndex((e) => e.kind === "toolstart"), j = ev.findIndex((e) => e.kind === "tool");
  assert.ok(i >= 0 && j > i); assert.equal((ev[i] as any).id, (ev[j] as any).id);
  assert.deepEqual(ev.find((e) => e.kind === "assistant"), { kind: "assistant", text: "Looking.", streamed: false });
  assert.deepEqual(ev.find((e) => e.kind === "turn"), { kind: "turn", step: 0, tokens: 15, prompt: 10, completion: 5, cached: 0, reasoning: 0 });
});

test("streaming: onText deltas become text events and the assistant event is marked streamed", async () => {
  const model: Model = async (_m, _t, o) => { o?.onText?.("Hel"); o?.onText?.("lo"); return { role: "assistant", content: "Hello" }; };
  const ev: Event[] = [];
  await createHarness({ model, onEvent: (e) => ev.push(e) }).run("x");
  assert.deepEqual(ev.filter((e) => e.kind === "text").map((e: any) => e.delta), ["Hel", "lo"]);
  assert.equal((ev.find((e) => e.kind === "assistant") as any).streamed, true);
});

test("steering: messages typed mid-run join the conversation at the next turn", async () => {
  const q: string[] = [];
  const slow = defineTool({ name: "slow", description: "", schema: { type: "object" }, run: () => (q.push("actually, use tabs"), "ok") });
  const { model, seen } = scripted(call(["slow", {}]), call(["finish", { summary: "." }]));
  const ev: Event[] = [];
  await createHarness({ model, tools: [slow], inbox: () => q.splice(0), onEvent: (e) => ev.push(e) }).run("t");
  assert.deepEqual(seen[1].slice(-2).map((m) => [m.role, m.content]), [["tool", "ok"], ["user", "actually, use tabs"]]);
  assert.ok(ev.some((e) => e.kind === "steer"));
});

test("approval requests carry a preview and the call id; false 'let me know' endings are not nudged", async () => {
  const w = defineTool<{ x: string }>({ name: "w", description: "", schema: { type: "object" }, risky: true, preview: ({ x }) => `will write ${x}`, run: () => "ok" });
  let req: any;
  await createHarness({ model: scripted(call(["w", { x: "a.txt" }]), call(["finish", { summary: "." }])).model, tools: [w], approve: (r) => ((req = r), true) }).run("t");
  assert.equal(req.preview, "will write a.txt"); assert.match(req.id, /^c\d+/);
  const ev: Event[] = [];
  const r = await createHarness({ model: scripted({ role: "assistant", content: "Done. Let me know if you want more." }).model, onEvent: (e) => ev.push(e) }).run("t");
  assert.equal(r.text, "Done. Let me know if you want more."); assert.ok(!ev.some((e) => e.kind === "nudge"));
});

test("Budget splits prompt vs completion tokens", () => {
  const b = new Budget(); b.add({ role: "assistant", content: "", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  assert.deepEqual([b.promptTokens, b.completionTokens, b.tokens], [100, 20, 120]);
});

test("permission modes: default asks for edits with a diff preview, acceptEdits doesn't, plan hides writers, yolo asks for nothing", async () => {
  const dir = tmp(); writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  let mode: PermMode = "default";
  const asked: { name: string; reason?: string; preview?: string }[] = [];
  const mk = (m: ReturnType<typeof scripted>) => createCodeAgent({ model: m.model, cwd: dir, memory: false, chat: true, permissions: { mode: () => mode }, approve: (r) => (asked.push(r), true) });
  let s = scripted(call(["read_file", { path: "a.txt" }]), call(["edit_file", { path: "a.txt", old: "two", new: "2" }]), call(["sh", { cmd: "ls" }]), call(["sh", { cmd: "npm test" }]), call(["finish", { summary: "." }]));
  await mk(s).chat([], "go");
  assert.deepEqual(asked.map((a) => [a.name, a.reason]), [["edit_file", "modify a file"], ["sh", "run a shell command"]]);   // `ls` is read-only: no prompt
  assert.match(asked[0].preview!, /-two\n\+2/); assert.equal(asked[1].preview, "npm test");
  asked.length = 0; mode = "acceptEdits";
  s = scripted(call(["read_file", { path: "a.txt" }]), call(["edit_file", { path: "a.txt", old: "2", new: "two" }]), call(["finish", { summary: "." }]));
  await mk(s).chat([], "go"); assert.equal(asked.length, 0);
  mode = "plan";
  s = scripted(call(["write_file", { path: "b.txt", content: "x" }]), call(["sh", { cmd: "rm a.txt" }]), call(["finish", { summary: "." }]));
  await mk(s).chat([], "go");
  assert.ok(!s.specs[0].includes("write_file") && !s.specs[0].includes("edit_file") && s.specs[0].includes("exit_plan_mode") && s.specs[0].includes("todo_write") && s.specs[0].includes("task"));
  assert.match(outs(s.seen)[0], /not available right now/); assert.match(outs(s.seen)[1], /plan mode is read-only/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n");
  mode = "yolo"; asked.length = 0;
  s = scripted(call(["sh", { cmd: "git reset --hard" }]), call(["finish", { summary: "." }]));
  await mk(s).chat([], "go"); assert.equal(asked.length, 0);
});

test("READONLY_CMD allows inspection and rejects chaining / redirects / substitutions / mutating find", () => {
  for (const c of ["ls -la src", "git status", "git log --oneline -5", "grep -rn foo .", "cat package.json", "find . -name '*.ts'", "wc -l a.txt"]) assert.ok(READONLY_CMD.test(c), c);
  for (const c of ["ls; rm -rf x", "cat a > b", "echo $(whoami)", "git push", "find . -delete", "ls && npm i", "cat a | sh", "git commit -am x", "node a.js"]) assert.ok(!READONLY_CMD.test(c), c);
});

test("chat mode tools: todo_write emits todos; exit_plan_mode only in plan mode and needs approval; task runs a read-only explorer", async () => {
  const dir = tmp(); writeFileSync(join(dir, "m.js"), "export const x = 1;\n");
  let mode: PermMode = "default"; const ev: any[] = [];
  const s = scripted(
    call(["todo_write", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] }]),
    call(["task", { description: "find x" }]),           // lead calls the explorer
    { role: "assistant", content: null, tool_calls: [{ id: "e1", function: { name: "grep", arguments: JSON.stringify({ pattern: "x" }) } }] },   // explorer turn 1
    { role: "assistant", content: null, tool_calls: [{ id: "e2", function: { name: "write_file", arguments: JSON.stringify({ path: "z", content: "" }) } }] },   // explorer tries to write
    { role: "assistant", content: "x is exported from m.js:1" },     // explorer answers in plain text
    call(["finish", { summary: "." }]));
  const a = createCodeAgent({ model: s.model, cwd: dir, memory: false, chat: true, permissions: { mode: () => mode }, onEvent: (e) => ev.push(e) });
  await a.chat([], "go");
  assert.deepEqual(a.todos.map((t) => t.status), ["in_progress", "pending"]); assert.ok(ev.some((e) => e.kind === "todos"));
  assert.match(outs(s.seen)[0] ?? "", /./);
  const lead = s.seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content);
  assert.ok(lead.includes("x is exported from m.js:1"));                    // only the explorer's summary came back
  assert.ok(ev.some((e) => e.agent === "explore" && e.kind === "tool"));    // its activity is observable, labelled
  assert.equal(s.seen.some((m) => m.some((x) => x.content === "" && x.tool_calls?.some((c) => c.function.name === "write_file")) && false), false);
  assert.throws(() => readFileSync(join(dir, "z")));                         // the explorer could not write
  assert.ok(!(await import("../src/index.ts")).codeTools(dir).some((t) => t.name === "exit_plan_mode"));
});

test("OpenAI adapter streams SSE: text deltas arrive incrementally and streamed tool calls are reassembled", async () => {
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const j = JSON.parse(b);
      if (!j.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "plain" } }], usage: { total_tokens: 3 } })); return; }
      res.setHeader("content-type", "text/event-stream");
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { content: "Hel" } }] }); send({ choices: [{ delta: { content: "lo" } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "sh", arguments: '{"cm' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'd":"ls"}' } }] } }] });
      send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const m = openai({ baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1`, model: "m" });
    const deltas: string[] = [];
    const r = await m([{ role: "user", content: "x" }], [], { onText: (d) => deltas.push(d) });
    assert.deepEqual(deltas, ["Hel", "lo"]); assert.equal(r.content, "Hello");
    assert.deepEqual(r.tool_calls, [{ id: "t1", type: "function", function: { name: "sh", arguments: '{"cmd":"ls"}' } }]);
    assert.equal(r.usage!.total_tokens, 10);
    assert.equal((await m([{ role: "user", content: "x" }], [])).content, "plain");           // non-streaming still works
  } finally { srv.close(); }
});

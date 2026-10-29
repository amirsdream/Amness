import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_GRADERS, Gate, chaosModel, chaosTools, choosingModel, createCodeAgent, createHarness, defineTool, gradeSessions, harnessVariant, loadPrompts, promptPlugin, rateLimited, readSession, scanSource, type Message, type Model } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "amness-tc-"));
const call = (name: string, args: object = {}): Message => ({ role: "assistant", content: null, usage: { total_tokens: 10 }, tool_calls: [{ id: "c" + Math.random(), function: { name, arguments: JSON.stringify(args) } }] });

test("plugin scan names what a plugin can touch, ignores comments, and says so when nothing is found", () => {
  const caps = scanSource(`import { execSync } from "node:child_process";\nconst k = process.env.OPENAI_API_KEY; await fetch("https://x"); // writeFileSync is only in a comment\nexport default { name: "x" };`).map((c) => c.id);
  assert.deepEqual(caps.sort(), ["env", "network", "shell"]); assert.deepEqual(scanSource(`export default { name: "x", hooks: { Stop: () => undefined } }; // fetch( here is a comment`), []);
  assert.ok(scanSource(`import("./" + name)`).some((c) => c.id === "dynamic-code")); assert.ok(scanSource(`writeFileSync(a, b)`).some((c) => c.id === "files-write"));
});

test("prompt registry: .amness/prompts/<id>.md replaces the system prompt (front matter ignored); unknown ids list what exists", () => {
  const d = tmp(); mkdirSync(join(d, ".amness", "prompts"), { recursive: true }); writeFileSync(join(d, ".amness", "prompts", "terse.md"), "---\ndescription: short\n---\nBe terse. Answer in one line.\n");
  process.env.AMNESS_HOME = tmp(); assert.deepEqual(loadPrompts(d).map((p) => [p.id, p.text]), [["terse", "Be terse. Answer in one line."]]);
  assert.equal(promptPlugin(d, "terse").system!("BASE", { cwd: d }), "Be terse. Answer in one line."); assert.equal(promptPlugin(d, "base").system, undefined);
  assert.throws(() => promptPlugin(d, "nope"), /no prompt "nope".*Found: terse/);
});

test("a context strategy may replace the conversation before each model request", async () => {
  const seen: number[] = []; const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "x".repeat(500) });
  const q = [call("noop", { i: 1 }), call("noop", { i: 2 }), call("noop", { i: 3 }), call("finish", { summary: "ok" })];
  const model: Model = async (m) => { seen.push(m.reduce((n, x) => n + (x.content?.length ?? 0), 0)); return q.shift()!; };
  await createHarness({ model, tools: [noop], off: ["stagnation", "loop", "compact", "condense"], context: (msgs) => msgs.map((m) => (m.role === "tool" && (m.content?.length ?? 0) > 100 ? { ...m, content: "[cleared]" } : m)) }).run("t");
  assert.ok(seen[3] < 1000, `tool results were cleared: ${seen.join(",")}`);
});

test("choosingModel routes each request to the model your function names; a broken function falls back to the first", async () => {
  const hit: string[] = []; const mk = (n: string): Model => (async () => ({ role: "assistant", content: n }) as Message) as Model;
  const m = choosingModel({ small: mk("small"), big: mk("big") }, ({ promptTokens }) => (promptTokens > 5 ? "big" : "small"), { onChoose: (k) => hit.push(k) });
  assert.equal((await m([{ role: "user", content: "hi" }], [])).content, "small"); assert.equal((await m([{ role: "user", content: "x".repeat(100) }], [])).content, "big");
  assert.equal((await choosingModel({ a: mk("a") }, () => { throw new Error("bug"); })([], [])).content, "a"); assert.deepEqual(hit, ["small", "big"]);
});

test("chaos: tools fail on purpose and the harness reads the error; a 429 is absorbed by the rate limiter; truncated arguments are repaired", async () => {
  const t = chaosTools([defineTool({ name: "ok", description: "", schema: { type: "object" }, run: () => "fine" })], { rate: 1 }); assert.match(String(await t[0].run({}, {} as any)), /simulated failure in ok/);
  let calls = 0; const base: Model = (async () => { calls++; return { role: "assistant", content: "answer" } as Message; }) as Model;
  const lim = rateLimited(chaosModel(base, { kind: "429", rate: 0.5, seed: 3 }), { gate: new Gate(), retries: 12 });
  for (let i = 0; i < 6; i++) assert.equal((await lim([], [])).content, "answer");
  const bad = await chaosModel((async () => call("noop", { a: 1 })) as Model, { kind: "args", rate: 1 })([], []); assert.throws(() => JSON.parse(bad.tool_calls![0].function.arguments));
  assert.ok(harnessVariant(base, "chaos:tools") && harnessVariant(base, "chaos:429")); assert.throws(() => harnessVariant(base, "chaos:nope"), /unknown chaos kind/);
  assert.ok(harnessVariant(base, "prompt:base")); assert.throws(() => harnessVariant(base, "model:x"), /needs models by id/); assert.ok(harnessVariant(base, "model:x", { modelFor: () => base }));
});

test("grading real sessions: traces become sessions, built-in and plugin graders score them, low scores are listed", async () => {
  const d = tmp(), f = join(d, "s1.jsonl"), g = join(d, "s2.jsonl");
  const line = (o: object) => JSON.stringify({ t: "x", ms: 1, ...o });
  writeFileSync(f, [line({ kind: "run", messages: [{ role: "user", content: "fix the bug" }] }), line({ kind: "model", message: { role: "assistant", tool_calls: [{ id: "a", function: { name: "edit_file", arguments: '{"path":"a.ts"}' } }, { id: "b", function: { name: "sh", arguments: '{"cmd":"npm test"}' } }] } }), line({ kind: "edit", path: "a.ts" }), line({ kind: "tool", id: "a", ok: true, result: "edited" }), line({ kind: "tool", id: "b", ok: true, result: "exit=0" }), line({ kind: "turn", prompt: 100, completion: 20, cached: 50 }), line({ kind: "finish", summary: "fixed" })].join("\n"));
  writeFileSync(g, [line({ kind: "run", messages: [{ role: "user", content: "change x" }] }), line({ kind: "model", message: { role: "assistant", tool_calls: [{ id: "a", function: { name: "edit_file", arguments: '{"path":"b.ts"}' } }] } }), line({ kind: "edit", path: "b.ts" }), line({ kind: "tool", id: "a", ok: false, result: "ERROR: no match" }), line({ kind: "rejected", detail: "x" }), line({ kind: "turn", prompt: 100, completion: 20, cached: 0 })].join("\n"));
  const s = readSession(f); assert.deepEqual([s.task, s.finished, s.steps, s.tokens, s.filesChanged, s.toolCalls.length], ["fix the bug", true, 1, 120, ["a.ts"], 2]);
  const rep = await gradeSessions([f, g], { ...BUILTIN_GRADERS, "small-diff": (x) => ({ score: x.filesChanged.length <= 1, note: "touches few files" }) });
  const by = Object.fromEntries(rep.map((r) => [r.grader, r])); assert.equal(by.finished.mean, 0.5); assert.equal(by["verified-edits"].mean, 0.5); assert.equal(by["no-rejections"].mean, 0.5); assert.equal(by["small-diff"].mean, 1); assert.equal(by["verified-edits"].low[0].session, "s2");
});

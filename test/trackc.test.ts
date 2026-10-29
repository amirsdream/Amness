import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("a plugin can replace the memory: its notes reach the first message, its search answers the tool, saves go to it, and it hears how the run ended", async () => {
  const d = tmp(), notes = new Map<string, any>([["style", { name: "style", type: "project", description: "code style", content: "use tabs", scope: "project", updated: "now" }]]), log: string[] = [];
  const backend = {
    list: () => [...notes.values()], save: (e: any) => { notes.set(e.name, { ...e, scope: e.scope ?? "project", updated: "now" }); log.push("save " + e.name); return notes.get(e.name); }, forget: (n: string) => notes.delete(n),
    search: async (q: string) => [...notes.values()].filter((e) => e.content.includes(q) || e.name.includes(q)), context: (task: string) => `## Memory (custom backend)\n- style: use tabs (task was: ${task.slice(0, 20)})`,
    delta: (text: string) => (/tabs/.test(text) ? "## Memory delta\n- style" : ""), endTurn: (ok: boolean | undefined) => { log.push("end " + String(ok)); },
  };
  const seen: Message[][] = [], q: Message[] = [call("memory_search", { query: "tabs" }), call("memory_save", { name: "db", type: "project", description: "database", content: "postgres 16" }), call("finish", { summary: "done" })];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return q.shift() ?? { role: "assistant", content: "ok" }; };
  const agent = createCodeAgent({ model, cwd: d, plugins: [{ name: "mem", memory: () => backend }], index: false, guidance: false, off: ["ledger"] });
  const r = await agent.run("add a helper"); assert.ok(seen[0].some((m) => /Memory \(custom backend\)/.test(m.content ?? "")));
  const tool = r.messages.filter((m) => m.role === "tool").map((m) => m.content!); assert.match(tool[0], /use tabs/); assert.match(tool[1], /saved memory/); assert.ok(notes.has("db")); assert.deepEqual(log, ["save db", "end true"]);
});

test("a plugin's route function picks the model per request (e.g. a cheap model for the first look, the strong one after a failure)", async () => {
  const d = tmp(), used: string[] = [], mk = (n: string): Model => (async (m: Message[]) => { used.push(n); return n === "cheap" ? call("list_files", {}) : { role: "assistant", content: "answer from " + n } as Message; }) as Model;
  const route = ({ tail }: any) => (tail.first ? "cheap" : undefined);
  const a = createCodeAgent({ model: mk("main"), modelById: (id) => mk(id), cwd: d, memory: false, chat: true, plugins: [{ name: "r", route }], index: false, guidance: false });
  const r = await a.chat([], "look around"); assert.deepEqual(used, ["cheap", "main"]); assert.match(r.text, /answer from main/);
});

test("sidebar shows plugin status lines (cached, failures hidden); /prompt lists and selects registry prompts", async () => {
  const { rig, say: sayR, KEY } = await import("./helpers/apprig.ts"); const { plain } = await import("./helpers/apprig.ts");
  const t = rig([sayR("ok")], { ui: "full", cols: 132, rows: 36 }); await t.start();
  t.app.plugins = [{ name: "ticket", status: () => "PROJ-42 in review" }, { name: "broken", status: () => { throw new Error("x"); } }];
  await t.submit("hello"); assert.ok(await t.until(() => t.idle())); await t.settle(1100); t.app.render(); assert.ok(await t.until(() => /ticket: PROJ-42 in review/.test(plain(t.screen()))), plain(t.screen()).slice(0, 2500));
  assert.deepEqual(t.app.pluginStatus(), ["ticket: PROJ-42 in review"]);
  mkdirSync(join(t.dir, ".amness", "prompts"), { recursive: true }); writeFileSync(join(t.dir, ".amness", "prompts", "terse.md"), "Be terse.");
  await t.submit("/prompt list"); assert.ok(await t.until(() => t.has("Available"))); await t.submit("/prompt terse"); assert.ok(await t.until(() => t.has("prompt terse on"))); assert.equal(t.app.cfg.prompt, "terse");
  assert.ok(t.app.activePlugins().some((p) => p.name === "prompt-terse")); await t.submit("/prompt nope"); assert.ok(await t.until(() => t.has('no prompt "nope"')));
  await t.submit("/prompt off"); assert.equal(t.app.cfg.prompt, undefined); await t.key(KEY.ctrlD);
});

test("amness plugin add copies a file into .amness/plugins, shows what it touches, refuses non-plugins, https-only URLs and overwrites", async () => {
  const { runPlugin } = await import("../cli/plugincli.ts"); const d = tmp(); const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error; console.log = (...a: any[]) => out.push(a.join(" ")); console.error = (...a: any[]) => err.push(a.join(" "));
  try {
    const src = join(d, "src.ts"); writeFileSync(src, 'import { execSync } from "node:child_process";\nexport default { name: "x" };\n'); writeFileSync(join(d, "notplugin.ts"), "console.log(1)\n");
    assert.equal(await runPlugin(["add", src], d), 0); assert.ok(out.join("\n").includes("runs shell commands")); assert.ok(existsSync(join(d, ".amness", "plugins", "src.ts")));
    assert.equal(await runPlugin(["add", src], d), 1); assert.match(err.join("\n"), /already exists/);
    assert.equal(await runPlugin(["add", join(d, "notplugin.ts")], d), 1); assert.match(err.join("\n"), /no `export default`/);
    assert.equal(await runPlugin(["add", "http://example.com/p.ts"], d), 2); assert.match(err.join("\n"), /only https/);
  } finally { console.log = log; console.error = error; }
});

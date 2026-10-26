import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBundle, createCodeAgent, createHarness, defineTool, MemoryStore, memoryTools, readBundle, startLive, unifiedDiff, type Event, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({
  role: "assistant", content: null, usage: { prompt_tokens: 100, total_tokens: 110 },
  tool_calls: cs.map(([name, a]) => ({ id: `c${++n}`, function: { name, arguments: JSON.stringify(a) } })),
});
const scripted = (...replies: Message[]) => {
  const seen: Message[][] = [];
  const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return replies.shift()!; };
  return { model, seen };
};
const tmp = () => mkdtempSync(join(tmpdir(), "amness-p-"));
const toolOut = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);

test("unifiedDiff: hunks, counts, new files, no-ops, and trailing-newline handling", () => {
  const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const b = a.replace("two\n", "TWO\n").replace("nine\n", "nine\nnine-and-a-half\n");
  const d = unifiedDiff("f.txt", a, b);
  assert.deepEqual([d.added, d.removed, d.created], [2, 1, false]);
  assert.match(d.diff, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -1,5 \+1,5 @@\n one\n-two\n\+TWO\n three/);
  assert.equal(d.diff.split("\n").filter((l) => l.startsWith("@@")).length, 2);               // far-apart edits -> two hunks
  assert.match(d.diff, /\+nine-and-a-half/);
  const c = unifiedDiff("new.js", null, "x\ny\n");
  assert.deepEqual([c.created, c.added, c.removed], [true, 2, 0]); assert.match(c.diff, /^--- \/dev\/null/);
  assert.equal(unifiedDiff("f", "same\n", "same\n").diff, "");
  assert.deepEqual([unifiedDiff("f", "a", "a\n").added, unifiedDiff("f", "", "a\n").added], [0, 1]);
  const big = unifiedDiff("big", "x\n".repeat(500), "y\n".repeat(500), 3, 50);
  assert.match(big.diff, /more diff lines$/);
});

test("code tools emit live edit events with real diffs", async () => {
  const dir = tmp(); writeFileSync(join(dir, "a.js"), "const a = 1;\nconst b = 2;\n");
  const events: Event[] = [];
  const { model } = scripted(call(["read_file", { path: "a.js" }]), call(["edit_file", { path: "a.js", old: "b = 2", new: "b = 3" }]), call(["write_file", { path: "new.js", content: "x\n" }]), call(["finish", { summary: "." }]));
  await createCodeAgent({ model, cwd: dir, memory: false, onEvent: (e) => events.push(e) }).run("t");
  const edits = events.filter((e): e is Extract<Event, { kind: "edit" }> => e.kind === "edit");
  assert.deepEqual(edits.map((e) => [e.path, e.created, e.added, e.removed]), [["a.js", false, 1, 1], ["new.js", true, 1, 0]]);
  assert.match(edits[0].diff, /-const b = 2;\n\+const b = 3;/);
  assert.ok(events.some((e) => e.kind === "turn"));
});

test("memory: save/search/forget, index file, scopes, validation, and framing", () => {
  const dir = tmp(), g = tmp();
  const m = new MemoryStore({ project: join(dir, "p"), global: g });
  m.save({ name: "Test Command!", type: "project", description: "how to run tests", content: "Use `pnpm test --run`, not npm." });
  m.save({ name: "tone", type: "user", description: "user prefers terse replies", content: "Keep answers short.", scope: "global" });
  assert.deepEqual(m.list().map((e) => [e.name, e.scope]), [["test-command", "project"], ["tone", "global"]]);
  assert.match(readFileSync(join(dir, "p", "MEMORY.md"), "utf8"), /\[test-command\]\(test-command\.md\) \(project\) — how to run tests/);
  assert.equal(m.search("which test runner command")[0].name, "test-command");
  const ctx = m.context("run the tests");
  assert.match(ctx, /not instructions/); assert.match(ctx, /Most relevant:[\s\S]*pnpm test/);
  assert.throws(() => m.save({ name: "x", type: "bogus" as any, description: "", content: "" }), /type must be/);
  assert.throws(() => m.save({ name: "x", type: "user", description: "", content: "y".repeat(5000) }), /too long/);
  assert.equal(m.forget("tone"), true); assert.equal(m.forget("tone"), false);
  assert.equal(new MemoryStore({ project: join(dir, "p") }).list().length, 1);                // persisted on disk
  const tools = memoryTools(m);
  assert.equal(tools.map((t) => t.name).join(), "memory_save,memory_search,memory_forget");
});

test("code agent injects memory into the task and the agent can save to it via tools", async () => {
  const dir = tmp(), mem = new MemoryStore({ project: join(dir, ".amness/memory") });
  mem.save({ name: "run-tests", type: "project", description: "test command", content: "Run `make check`." });
  const { model, seen } = scripted(call(["memory_save", { name: "style", type: "feedback", description: "naming", content: "Use snake_case." }]), call(["finish", { summary: "." }]));
  await createCodeAgent({ model, cwd: dir, memory: mem }).run("add tests");
  assert.match(seen[0][1].content!, /add tests[\s\S]*Memory \(notes[\s\S]*run-tests[\s\S]*make check/);
  assert.match(toolOut(seen)[0], /saved memory "style"/);
  assert.ok(existsSync(join(dir, ".amness/memory/style.md")));
});

test("rollover: big context -> handoff note -> fresh context seeded with task + note; budget and loop-guard reset", async () => {
  const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "ok" });
  const notes: string[] = [], events: Event[] = [];
  const hi = (p: number): Message => ({ ...call(["noop", { i: ++n }]), usage: { prompt_tokens: p, total_tokens: p + 10 } });
  const { model, seen } = scripted(hi(50), hi(900), { role: "assistant", content: "GOAL: x\nDONE: step one\nNEXT: step two" }, call(["finish", { summary: "done" }]));
  const r = await createHarness({ model, tools: [noop], rollover: { afterTokens: 500 }, onHandoff: (x) => notes.push(x), onEvent: (e) => events.push(e) }).run("original task");
  assert.equal(r.text, "done"); assert.match(notes[0], /DONE: step one/); assert.ok(events.some((e) => e.kind === "rollover"));
  const hand = seen[2].at(-1)!;                                                                // the handoff request is the last user message
  assert.match(hand.content!, /Write a handoff note/);
  const fresh = seen[3];                                                                       // after rollover: system + one seeded user message
  assert.equal(fresh.length, 2); assert.match(fresh[1].content!, /original task[\s\S]*Handoff from your earlier context[\s\S]*step two/);
  assert.ok(!fresh.some((m) => m.role === "tool"));
});

test("portable bundle: export from one agent, import into another repo; safe path handling and no clobbering", async () => {
  const a = tmp(), b = tmp();
  writeFileSync(join(a, "app.js"), "old\n");
  const first = scripted(call(["read_file", { path: "app.js" }]), call(["write_file", { path: "app.js", content: "fixed\n" }]), call(["write_file", { path: "lib/util.js", content: "u\n" }]), call(["finish", { summary: "fixed app" }]));
  const mem = new MemoryStore({ project: join(a, ".amness/memory") }); mem.save({ name: "cmd", type: "project", description: "d", content: "run it" });
  const agent = createCodeAgent({ model: first.model, cwd: a, memory: mem, meta: { provider: "openai", model: "gpt-x" } });
  const res = await agent.run("fix app");
  const out = join(a, ".amness/sessions/s.json");
  const { bundle } = await agent.exportBundle(res, out, "GOAL: fix app\nNEXT: add tests");
  assert.deepEqual(Object.keys(bundle.files).sort(), ["app.js", "lib/util.js"]); assert.equal(readBundle(out).from.model, "gpt-x"); assert.equal(bundle.memory.length, 1);
  assert.ok(!JSON.stringify(bundle).includes("tool_calls"));                                  // no provider-specific transcript inside

  writeFileSync(join(b, "app.js"), "mine\n");                                                 // target already has a different app.js
  const second = scripted(call(["finish", { summary: "." }]));
  const mem2 = new MemoryStore({ project: join(b, ".amness/memory") });
  await createCodeAgent({ model: second.model, cwd: b, memory: mem2 }).run("continue", { bundle: out });
  assert.equal(readFileSync(join(b, "app.js"), "utf8"), "mine\n");                            // kept
  assert.equal(readFileSync(join(b, "lib/util.js"), "utf8"), "u\n");                          // restored
  assert.equal(mem2.list()[0].name, "cmd");
  const prompt = second.seen[0][1].content!;
  assert.match(prompt, /continue[\s\S]*Handoff from a previous session[\s\S]*add tests[\s\S]*kept your version of: app\.js/);
  const evil = { ...bundle, files: { "../../escape.txt": "x", "/abs.txt": "y" } };
  assert.equal(applyBundle(evil, { cwd: b }).restored.length, 0);
  assert.throws(() => readBundle(join(a, "app.js")), /not an amness session bundle|Unexpected/);
});

test("live server: serves the page, replays history over SSE, blocks foreign Host headers", async () => {
  const live = await startLive({ title: "t" });
  try {
    live.onEvent({ kind: "edit", path: "<img src=x onerror=alert(1)>.js", created: true, added: 1, removed: 0, diff: "+x" });
    const page = await (await fetch(live.url)).text();
    assert.match(page, /EventSource/); assert.match(page, /textContent/); assert.ok(!/innerHTML/.test(page));   // untrusted diffs never become HTML
    const res = await fetch(live.url + "/events"), reader = res.body!.getReader();
    const { value } = await reader.read();
    const msg = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
    assert.equal(msg.kind, "edit"); assert.equal(msg.added, 1);
    live.onEvent({ kind: "finish", summary: "ok" });
    assert.match(new TextDecoder().decode((await reader.read()).value), /"finish"/);
    await reader.cancel();
    const foreign = await new Promise<number>((ok) => {
      import("node:http").then(({ request }) => { const rq = request({ host: "127.0.0.1", port: Number(new URL(live.url).port), path: "/", headers: { host: "evil.example" } }, (r) => { r.resume(); ok(r.statusCode!); }); rq.end(); });
    });
    assert.equal(foreign, 403);
  } finally { await live.close(); }
});

test("live page script is valid JavaScript", async () => {
  const live = await startLive();
  try {
    const page = await (await fetch(live.url)).text();
    const js = page.match(/<script>([\s\S]*)<\/script>/)![1];
    new Function(js);                                                                          // throws on syntax errors
  } finally { await live.close(); }
});

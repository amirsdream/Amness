import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeHooks, createCodeAgent, createHarness, definePlugin, defineTool, findPluginVariant, harnessVariant, importPlugins, loadPlugins, pluginFingerprint, type Message, type Model } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "amness-plug-"));
const call = (name: string, args: object = {}): Message => ({ role: "assistant", content: null, usage: { total_tokens: 10 }, tool_calls: [{ id: "c" + Math.random(), function: { name, arguments: JSON.stringify(args) } }] });
const put = (d: string, rel: string, body: string) => { const f = join(d, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); return f; };
const PLUGIN = (name: string, extra = "") => `export default { name: ${JSON.stringify(name)}, ${extra} };\n`;

test("plugins load from the user folder always and the project folder only when trusted; bad ones are warnings", async () => {
  const proj = tmp(), user = tmp();
  put(user, "plugins/u.ts", PLUGIN("userone")); put(proj, ".amness/plugins/p.ts", PLUGIN("projone")); put(proj, ".amness/plugins/bad.ts", "export default { nope: 1 };\n"); put(proj, ".amness/plugins/boom.js", "throw new Error('syntax boom');\n"); put(proj, ".amness/plugins/dup.mjs", PLUGIN("projone"));
  const off = await loadPlugins(proj, { userDir: user }); assert.deepEqual(off.plugins.map((p) => p.name), ["userone"]); assert.equal(off.untrusted?.count, 4); assert.equal(off.untrusted?.fingerprint, pluginFingerprint(proj));
  const on = await loadPlugins(proj, { userDir: user, trustProject: true });
  assert.deepEqual(on.plugins.map((p) => p.name), ["userone", "projone"]); assert.equal(on.warnings.length, 3); assert.ok(on.warnings.some((w) => /needs a "name"/.test(w)) && on.warnings.some((w) => /syntax boom/.test(w)) && on.warnings.some((w) => /already loaded/.test(w)));
  const before = pluginFingerprint(proj); put(proj, ".amness/plugins/p.ts", PLUGIN("projone", "description: 'changed'")); assert.notEqual(pluginFingerprint(proj), before);        // editing a plugin invalidates the approval
});

test("in-process hooks follow the shell-hook rules: first block wins, context accumulates, args rewrite, failures warn (or block when failClosed)", async () => {
  const a = definePlugin({ name: "a", hooks: { PreToolUse: () => "note A", PostToolUse: () => { throw new Error("oops"); } } });
  const b = definePlugin({ name: "b", failClosed: true, hooks: { PreToolUse: ({ tool }) => (tool === "sh" ? { block: "no shell here" } : { context: "note B", args: { x: 1 } }), PostToolUse: () => { throw new Error("must stop"); } } });
  const h = composeHooks(undefined, [a, b], "/x")!;
  assert.equal(h.count(), 4);
  assert.deepEqual(await h.run("PreToolUse", { tool: "read_file" }), { warnings: [], context: "note A\nnote B", args: { x: 1 } });
  assert.equal((await h.run("PreToolUse", { tool: "sh" })).block, "no shell here");
  const post = await h.run("PostToolUse", {}); assert.ok(post.warnings[0].includes("plugin a (PostToolUse): oops")); assert.match(post.block!, /plugin b.*must stop/);
  assert.equal(composeHooks(undefined, [definePlugin({ name: "empty" })], "/x"), undefined);
});

test("PreModel runs before every model call (may add a note or stop the run); PostModel sees what the model said", async () => {
  const seen: string[] = []; const notes: Message[][] = [];
  const hooks = composeHooks(undefined, [definePlugin({ name: "watch", hooks: { PreModel: ({ step }) => (step === 1 ? "remember the style guide" : step === 3 ? { block: "enough steps" } : undefined), PostModel: ({ text, tools }) => { seen.push(`${String(text)}|${(tools as string[]).join(",")}`); } } })], "/x")!;
  const noop = defineTool({ name: "noop", description: "", schema: { type: "object" }, run: () => "ok" });
  const model: Model = async (m) => { notes.push(m.map((x) => ({ ...x }))); return call("noop"); };
  const r = await createHarness({ model, tools: [noop], hooks, off: ["stagnation", "loop"] }).run("t");
  assert.equal(r.stopped, "blocked"); assert.match(r.text, /enough steps/); assert.equal(seen.length, 3); assert.equal(seen[0], "|noop");
  assert.ok(notes[1].some((m) => m.role === "user" && m.content === "remember the style guide")); assert.ok(!notes[0].some((m) => m.content === "remember the style guide"));
});

test("a plugin's tools and system prompt reach the agent", async () => {
  const d = tmp(); let sys = "", tools: string[] = [];
  const model: Model = async (m, s) => { sys = m[0].content ?? ""; tools = s.map((x) => x.name); return { role: "assistant", content: "hi" }; };
  const p = definePlugin({ name: "x", tools: [defineTool({ name: "ticket_lookup", description: "look up a ticket", schema: { type: "object" }, run: () => "T-1" })], system: (base) => base + "\nAlways mention ticket numbers." });
  await createCodeAgent({ model, cwd: d, memory: false, chat: true, plugins: [p], index: false, guidance: false }).chat([], "hello");
  assert.match(sys, /Always mention ticket numbers\./); assert.ok(tools.includes("ticket_lookup"));
});

test("eval: a plugin defines a harness variant and tasks with function graders; the variant runs and is graded", async () => {
  const d = tmp(), f = put(d, "myplug.ts", `
    export default { name: "mine",
      cases: [{ name: "write-file", files: {}, task: "create out.txt containing hi", check: async (dir) => (await import("node:fs")).readFileSync(dir + "/out.txt", "utf8") === "hi" || "wrong content" }],
      variants: { "no-guards-plus-prompt": { off: ["nudge", "loop"], verify: false, system: (b) => b + "\\nBe terse." } } };`);
  const { plugins, warnings } = await importPlugins(f); assert.equal(warnings.length, 0); assert.ok(findPluginVariant(plugins, "mine:no-guards-plus-prompt") && findPluginVariant(plugins, "no-guards-plus-prompt") && !findPluginVariant(plugins, "x"));
  let sys = ""; const model: Model = (async (m: Message[]) => { sys = m[0].content ?? ""; const n = m.filter((x) => x.role === "assistant").length; return n === 0 ? call("write_file", { path: "out.txt", content: "hi" }) : n === 1 ? call("finish", { summary: "done" }) : { role: "assistant", content: "x" }; }) as Model;
  const v = harnessVariant(model, "mine:no-guards-plus-prompt", { plugins }), dir = tmp();
  const out = await v.run(plugins[0].cases![0], dir); assert.match(sys, /Be terse\./); assert.ok(out.steps >= 1);
  assert.equal(await (plugins[0].cases![0].check as (d: string) => unknown)(dir), true);
});

test("plugin slash commands appear in the chat, run with a small safe API, and are skipped when a built-in has the name; /reload-plugins works", async () => {
  const { rig, say: sayR, KEY } = await import("./helpers/apprig.ts"); const { plain } = await import("./helpers/apprig.ts");
  const t = rig([sayR("sent to the agent")]); await t.start();
  t.app.plugins = [definePlugin({ name: "demo", commands: [
    { name: "hello", help: "greet", run: (ctx) => ctx.say("hello from demo in " + ctx.cwd.slice(-4)) },
    { name: "ask-it", help: "send a message", run: async (ctx) => { await ctx.ask("please list files"); } },
    { name: "exit", help: "clashes with a built-in", run: (ctx) => ctx.say("must not run") },
    { name: "boom", help: "throws", run: () => { throw new Error("kaput"); } },
  ] })];
  await t.submit("/hello"); assert.ok(await t.until(() => t.has("hello from demo")));
  await t.submit("/boom"); assert.ok(await t.until(() => t.has("failed: kaput")));
  await t.submit("/ask-it"); assert.ok(await t.until(() => t.seen.length >= 1 && t.idle())); assert.ok(t.seen[0].msgs.some((m) => (m.content ?? "").includes("please list files")));
  assert.ok(!t.app.cmds.some((c) => c.help.includes("clashes") && c.name === "exit" && c.help.includes("plugin"))); assert.ok(t.app.cmds.some((c) => c.name === "hello"));
  await t.submit("/reload-plugins"); assert.ok(await t.until(() => t.has("plugin") && t.has("loaded")));
  await t.key(KEY.ctrlD); void plain;
});

test("finish gates: see what really happened, can run commands, reject at most twice, and voting needs a quorum", async () => {
  const { votingGate } = await import("../src/index.ts"); const d = tmp(); writeFileSync(join(d, "ok.txt"), "x");
  let seenCtx: any;
  const gate = { name: "needs-tests", check: async (c: any) => { seenCtx = c; const r = await c.run("test -f ok.txt"); return c.changed.length && !c.testsAfterLastEdit ? `tests were not run after editing ${c.changed.join(", ")} (file check exit ${r.code})` : true; } };
  const h = composeHooks(undefined, [definePlugin({ name: "g", gates: [gate] })], d)!; assert.equal(h.count(), 1);
  const payload = { summary: "done", task: "t1", changed: ["a.ts"], testsAfterLastEdit: false, notes: [] };
  const r1 = await h.run("Stop", payload); assert.match(r1.block!, /gate "needs-tests".*tests were not run after editing a\.ts \(file check exit 0\)/s); assert.equal(seenCtx.rejections, 0);
  assert.ok((await h.run("Stop", payload)).block); const r3 = await h.run("Stop", payload); assert.equal(r3.block, undefined); assert.match(r3.warnings[0], /finishing despite/);          // the third time it lets go
  assert.ok((await h.run("Stop", { ...payload, task: "t2" })).block);                                                                                   // a new task starts the count again
  assert.equal((await h.run("Stop", { ...payload, task: "t3", testsAfterLastEdit: true })).block, undefined);
  const vote = votingGate("panel", [{ name: "a", review: () => true }, { name: "b", review: () => "missing docs" }, { name: "c", review: () => true }], "majority");
  assert.equal(await vote.check({} as any), true);
  const strict = await votingGate("panel", [{ name: "a", review: () => true }, { name: "b", review: () => "missing docs" }], "all").check({} as any) as any; assert.equal(strict.pass, false); assert.match(strict.findings.join(" "), /only 1 of 2.*b: missing docs/);
});

test("policy as code: deny wins, ask forces a prompt, allow skips an ordinary prompt but never the floor; a broken policy never allows", async () => {
  const d = tmp(); writeFileSync(join(d, "a.txt"), "x");
  const run = async (policy: any, cmd: string, approve: (r: any) => any = () => true) => {
    const asked: any[] = []; const q: Message[] = [call("sh", { cmd }), { role: "assistant", content: "done" }];
    const a = createCodeAgent({ model: async () => q.shift()!, cwd: d, memory: false, chat: true, plugins: [definePlugin({ name: "pol", policy })], approve: (r) => { asked.push(r); return approve(r); }, permissions: { mode: () => "default" }, index: false, guidance: false });
    const r = await a.chat([], "go"); return { asked, out: r.messages.find((m) => m.role === "tool")!.content! };
  };
  const deny = await run(({ tool, args }: any) => (tool === "sh" && /curl/.test(String(args.cmd)) ? { action: "deny", reason: "no network tools" } : undefined), "curl http://x"); assert.match(deny.out, /DENIED: no network tools/); assert.equal(deny.asked.length, 0);
  const ask = await run(() => "ask", "echo hi"); assert.equal(ask.asked.length, 1);
  const allow = await run(() => "allow", "echo hi"); assert.equal(allow.asked.length, 0); assert.match(allow.out, /hi/);                                       // an ordinary shell command no longer asks
  const floor = await run(() => "allow", "rm -rf /"); assert.ok(floor.asked.length === 1 || /DENIED/.test(floor.out), "the floor is not relaxed: " + floor.out);
  const broken = await run(() => { throw new Error("bug in my policy"); }, "echo hi"); assert.equal(broken.asked.length, 1);
});

test("strategies: plan-first asks for a text plan before any tool; explore-then-act refuses edits for the first steps and then allows them", async () => {
  const { planFirst, exploreThenAct } = await import("../src/index.ts"); const d = tmp(); writeFileSync(join(d, "a.txt"), "one\n");
  const run = async (plugin: any, replies: Message[]) => {
    const q = [...replies], seen: Message[][] = []; const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return q.shift() ?? { role: "assistant", content: "done" }; };
    const r = await createCodeAgent({ model, cwd: d, memory: false, chat: true, plugins: [plugin], approve: () => true, permissions: { mode: () => "acceptEdits" }, index: false, guidance: false, off: ["stagnation", "loop"] }).chat([], "change a.txt to two");
    return { seen, tools: r.messages.filter((m) => m.role === "tool").map((m) => m.content!) };
  };
  const p = await run(planFirst(), [call("read_file", { path: "a.txt" }), { role: "assistant", content: "ok" }]);
  assert.match(p.tools[0], /not allowed in this phase.*answer in text/); assert.ok(p.seen[0].some((m) => /short numbered plan/.test(m.content ?? "")));      // the first reply could not use tools
  const e = await run(exploreThenAct({ readSteps: 2 }), [call("write_file", { path: "a.txt", content: "two\n" }), call("read_file", { path: "a.txt" }), call("write_file", { path: "a.txt", content: "two\n" }), { role: "assistant", content: "done" }]);
  assert.match(e.tools[0], /write_file is not allowed in this phase/); assert.doesNotMatch(e.tools[2], /not allowed/);                                       // step 2: phase 2 begins
  assert.ok(e.seen.at(-1)!.some((m) => /Phase 2 starts now/.test(m.content ?? "")));
});

test("plan-first: the text plan does not end the run; the model is asked to carry it out and the tools then work", async () => {
  const { planFirst } = await import("../src/index.ts"); const d = tmp(); writeFileSync(join(d, "a.txt"), "one\n");
  const q: Message[] = [{ role: "assistant", content: "1. read a.txt 2. report" }, call("read_file", { path: "a.txt" }), { role: "assistant", content: "It says one." }], seen: Message[][] = [];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return q.shift()!; };
  const r = await createCodeAgent({ model, cwd: d, memory: false, chat: true, plugins: [planFirst()], index: false, guidance: false }).chat([], "what is in a.txt?");
  assert.equal(seen.length, 3); assert.ok(seen[1].some((m) => /carry out the plan/.test(m.content ?? ""))); assert.match(r.text, /It says one/); assert.ok(r.messages.some((m) => m.role === "tool" && /one/.test(m.content ?? "")));
});

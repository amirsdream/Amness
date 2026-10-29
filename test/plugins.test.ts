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

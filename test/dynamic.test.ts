import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, createHarness, createToolTool, defineTool, loadMcp, loadSavedTools, Registry, shellTool, type Message, type Model, type ToolSpec } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({
  role: "assistant", content: null,
  tool_calls: cs.map(([name, a]) => ({ id: `c${++n}`, function: { name, arguments: JSON.stringify(a) } })),
});
const scripted = (...replies: Message[]) => {
  const seen: Message[][] = [], specs: ToolSpec[][] = [];
  const model: Model = async (msgs, sp) => { seen.push(msgs.map((m) => ({ ...m }))); specs.push(sp); return replies.shift()!; };
  return { model, seen, specs };
};
const toolOut = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);
const names = (s: ToolSpec[]) => s.map((t) => t.name);
const mk = (name: string, desc = "", extra: object = {}) => defineTool({ name, description: desc, schema: { type: "object" }, run: () => name + " ran", ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), "amness-d-"));

test("a tool can add tools mid-run via ctx.registry; they appear next turn", async () => {
  const reg = new Registry([defineTool({ name: "unlock", description: "", schema: { type: "object" }, run: (_a, { registry }) => (registry.add(mk("bonus")), "ok") })]);
  const { model, specs } = scripted(call(["unlock", {}]), call(["bonus", {}]), call(["finish", { summary: "." }]));
  await createHarness({ model, tools: reg }).run("t");
  assert.deepEqual([names(specs[0]), names(specs[1])], [["unlock", "finish"], ["bonus", "unlock", "finish"]]);   // tool definitions are sorted by name: a stable order keeps the provider cache valid across sessions
});

test("`when` gates availability per turn", async () => {
  const late = mk("late", "", { when: ({ step }: { step: number }) => step >= 1 });
  const { model, specs, seen } = scripted(call(["late", {}]), call(["late", {}]), call(["finish", { summary: "." }]));
  await createHarness({ model, tools: [mk("any"), late] }).run("t");
  assert.deepEqual(names(specs[0]), ["any", "finish"]); assert.ok(names(specs[1]).includes("late"));
  assert.match(toolOut(seen)[0], /not available right now/); assert.equal(toolOut(seen)[1], "late ran");
});

test("deferred tools: menu + tool_search loads them; premature call self-heals", async () => {
  const reg = new Registry([mk("core"), mk("jira_create", "create a jira ticket", { deferred: true }), mk("slack_post", "post a slack message", { deferred: true })]);
  const { model, specs, seen } = scripted(
    call(["slack_post", {}]),                    // not loaded: gets loaded + error
    call(["tool_search", { query: "jira ticket" }]),
    call(["jira_create", {}]), call(["slack_post", {}]), call(["finish", { summary: "." }]));
  await createHarness({ model, tools: reg }).run("t");
  assert.deepEqual(names(specs[0]), ["core", "tool_search", "finish"]);
  assert.match(specs[0][1].description, /jira_create: create a jira ticket[\s\S]*slack_post/);
  const t = toolOut(seen);
  assert.match(t[0], /was not loaded yet; it is now/); assert.match(t[1], /Loaded[\s\S]*jira_create/);
  assert.deepEqual(t.slice(2), ["jira_create ran", "slack_post ran"]);
  assert.ok(!names(specs[3]).includes("tool_search")); // nothing left to discover -> menu disappears
});

test("create_tool: approval required, shell-quoted args can't inject, persists and reloads", async () => {
  const dir = tmp(), file = join(dir, "tools.json");
  const def = { name: "say", description: "echo text", command: "echo got:{{text}}", params: { text: { type: "string" } } };
  const reg = new Registry([createToolTool({ cwd: dir, file })]);
  let s = scripted(call(["create_tool", def]), call(["say", { text: "$(touch pwned); 'x'" }]), call(["finish", { summary: "." }]));
  const asked: string[] = [];
  await createHarness({ model: s.model, tools: reg, approve: (r) => (asked.push(r.reason!), true) }).run("t");
  assert.match(asked[0], /echo got:\{\{text\}\}/);
  assert.match(toolOut(s.seen)[1], /got:\$\(touch pwned\); 'x'/);       // literal, not executed
  assert.throws(() => readFileSync(join(dir, "pwned")));
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].name, "say");
  assert.equal(loadSavedTools(file, dir)[0].name, "say");
  s = scripted(call(["create_tool", def]), call(["finish", { summary: "." }]));                // no approver -> denied
  const reg2 = new Registry([createToolTool({ cwd: dir })]);
  await createHarness({ model: s.model, tools: reg2 }).run("t");
  assert.match(toolOut(s.seen)[0], /DENIED/); assert.equal(reg2.get("say"), undefined);
});

test("create_tool validates names and placeholders", async () => {
  const reg = new Registry([createToolTool({ cwd: tmp() }), mk("existing")]);
  const run = (a: object) => reg.get("create_tool")!.run(a, { registry: reg, step: 0 });
  assert.match(await run({ name: "Bad Name", description: "", command: "x" }) as string, /snake_case/);
  assert.match(await run({ name: "existing", description: "", command: "x" }) as string, /already exists/);
  assert.match(await run({ name: "ok_tool", description: "", command: "echo {{nope}}" }) as string, /undeclared param/);
  assert.match(await run({ name: "ok_tool", description: "", command: "x", params: { a: { type: "object" } } }) as string, /bad param/);
});

test("MCP: loads (paginated) tools, calls them, flags destructive ones, defers big sets", async () => {
  const mcp = await loadMcp("node", ["test/fake-mcp.mjs"], { prefix: "fake" });
  try {
    assert.deepEqual(mcp.tools.map((t) => t.name), ["fake__echo", "fake__wipe"]);
    assert.equal(mcp.tools[0].risky, false); assert.equal(typeof mcp.tools[1].risky, "function");
    const ctx = { registry: new Registry(), step: 0 };
    assert.equal(await mcp.tools[0].run({ text: "hi" }, ctx), "echo:hi");
    await assert.rejects(Promise.resolve(mcp.tools[1].run({}, ctx)), /nope/);
    const { model, seen } = scripted(call(["fake__echo", { text: "yo" }]), call(["fake__wipe", {}]), call(["finish", { summary: "." }]));
    await createHarness({ model, tools: mcp.tools }).run("t");
    assert.match(toolOut(seen)[0], /^\[untrusted content from fake__echo[\s\S]*\necho:yo\n\[end of untrusted content\]$/);   // MCP output is wrapped as data assert.match(toolOut(seen)[1], /DENIED/);
  } finally { mcp.close(); }
  const big = await loadMcp("node", ["test/fake-mcp.mjs"], { env: { EXTRA: "20" }, deferAbove: 10 });
  try { assert.equal(big.tools.length, 22); assert.ok(big.tools.every((t) => t.deferred)); } finally { big.close(); }
});

test("code agent selfExtend: tool created at runtime is usable and reloaded in a new agent", async () => {
  const dir = tmp();
  const s = scripted(call(["create_tool", { name: "hello", description: "d", command: "echo hi", params: {} }]), call(["hello", {}]), call(["finish", { summary: "." }]));
  const a = createCodeAgent({ model: s.model, cwd: dir, selfExtend: true, approve: () => true });
  await a.run("t");
  assert.match(toolOut(s.seen)[1], /exit=0\nhi/);
  assert.ok(createCodeAgent({ model: s.model, cwd: dir, selfExtend: true }).registry.get("hello"));
  assert.equal(shellTool({ name: "z", description: "", command: "true", params: {} }, dir).name, "z");
});

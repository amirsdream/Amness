import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, createCodeAgent, createWorktree, isRepo, loadAgents, removeWorktree, worktreeDiff, type Message, type Model } from "../src/index.ts";

const root = () => mkdtempSync(join(tmpdir(), "amness-ag-"));
const put = (base: string, rel: string, text: string) => { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); };
const agentMd = (name: string, extra: string, body = "You are careful.") => `---\nname: ${name}\ndescription: does ${name} things\n${extra}\n---\n${body}\n`;
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString();
const repo = () => { const d = root(); git(d, "init", "-q"); put(d, "a.txt", "one\n"); git(d, "add", "."); git(d, "commit", "-qm", "init"); return d; };
let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "g" + ++n, function: { name, arguments: JSON.stringify(args) } }] });

test("agents: discovered from .amness/agents and .claude/agents, tools filtered to the allowed set, bad files reported, explore is reserved", () => {
  const p = root(), h = root();
  put(p, ".amness/agents/reviewer.md", agentMd("reviewer", "tools: read_file, grep, nonsense_tool\nmodel: fast\nmax-steps: 99"));
  put(p, ".claude/agents/fixer.md", agentMd("fixer", "tools: read_file, edit_file, sh\nisolation: worktree")); put(h, ".claude/agents/fixer.md", agentMd("fixer", "tools: read_file")); put(h, ".amness/agents/home.md", agentMd("home", ""));
  put(p, ".amness/agents/explore.md", agentMd("explore", "")); put(p, ".amness/agents/nodesc.md", "---\nname: nodesc\n---\nx"); put(p, ".amness/agents/plain.md", "no front matter");
  const r = loadAgents(p, { userHome: h }), by = (n: string) => r.agents.find((a) => a.name === n)!;
  assert.deepEqual(r.agents.map((a) => a.name).sort(), ["fixer", "home", "reviewer"]);
  assert.deepEqual(by("reviewer").tools, ["read_file", "grep"]); assert.equal(by("reviewer").model, "fast"); assert.equal(by("reviewer").maxSteps, 60);
  assert.deepEqual([by("fixer").isolation, by("fixer").scope, by("fixer").tools], ["worktree", "project", ["read_file", "edit_file", "sh"]]);         // the project's wins over the user's
  assert.deepEqual(by("home").tools, ["list_files", "read_file", "grep"]);
  assert.equal(r.warnings.length, 4); assert.ok(r.warnings.some((w) => /nonsense_tool/.test(w)) && r.warnings.some((w) => /"explore" is built in/.test(w)) && r.warnings.some((w) => /needs a "description:"/.test(w)) && r.warnings.some((w) => /needs front matter/.test(w)));
});

test("worktree: isolated copy of HEAD; changes come back as a diff; the main tree is untouched; the diff can be applied", async () => {
  const d = repo(); assert.equal(await isRepo(d), true); assert.equal(await isRepo(root()), false);
  const w = await createWorktree(d); writeFileSync(join(w.dir, "a.txt"), "two\n"); writeFileSync(join(w.dir, "new.txt"), "hello\n");
  const diff = await worktreeDiff(w); assert.match(diff, /diff --git a\/a\.txt[\s\S]*-one[\s\S]*\+two/); assert.match(diff, /new file[\s\S]*\+hello/);
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "one\n"); assert.ok(!existsSync(join(d, "new.txt")));
  assert.equal(await applyDiff(d, diff), undefined); assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "two\n"); assert.equal(readFileSync(join(d, "new.txt"), "utf8"), "hello\n");
  assert.match((await applyDiff(d, diff))!, /./);                                                                                                   // applying twice fails and says so
  await removeWorktree(w); assert.ok(!existsSync(w.dir)); assert.ok(!git(d, "worktree", "list").includes("amness-wt"));
});

const lead = (cwd: string, leadQ: Message[], subModel: Model, extra: object = {}) => createCodeAgent({ model: async (m, s) => (m[0].content ?? "").includes("You are a subagent") || /careful|reviewer/.test(m[0].content ?? "") ? subModel(m, s) : leadQ.shift()!, cwd, memory: false, guidance: false, chat: true, permissions: { mode: () => "yolo" }, ...extra });

test("task tool: a custom read-only agent gets only its tools and its own prompt, returns only its summary, and an unknown agent name falls back to the explorer with a note", async () => {
  const d = repo(); put(d, ".amness/agents/reviewer.md", agentMd("reviewer", "tools: read_file, grep", "You are careful and review."));
  const seen: { sys: string; tools: string[] }[] = [];
  const sub: Model = async (m, s) => (seen.push({ sys: m[0].content ?? "", tools: s.map((x) => x.name) }), seen.length === 1 ? call("read_file", { path: "a.txt" }) : call("finish", { summary: "a.txt says one" }));
  const a = lead(d, [call("task", { description: "check a.txt", agent: "reviewer" }), call("task", { description: "x", agent: "ghost" }), call("finish", { summary: "explored" }), { role: "assistant", content: "done" }], sub);
  const r = await a.chat([], "go"), outs = r.messages.filter((m) => m.role === "tool").map((m) => m.content!);
  assert.equal(outs[0], "a.txt says one"); assert.match(outs[1], /no agent named "ghost"; the read-only explorer answered. Available: explore, reviewer/);
  assert.match(seen[0].sys, /You are careful and review\./); assert.deepEqual(seen[0].tools.filter((t) => t !== "finish").sort(), ["grep", "read_file"]);
});

test("task tool: a writing agent edits for real, shares the ledger, and is forced read-only in plan mode", async () => {
  const d = repo(); put(d, ".amness/agents/fixer.md", agentMd("fixer", "tools: read_file, edit_file", "You are careful and fix."));
  let step = 0; const sub: Model = async () => [call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "one", new: "ONE" }), call("finish", { summary: "uppercased" })][step++];
  const ev: any[] = []; const a = lead(d, [call("task", { description: "uppercase a.txt", agent: "fixer" }), { role: "assistant", content: "ok" }], sub, { onEvent: (e: any) => ev.push(e) });
  await a.chat([], "go"); assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "ONE\n"); assert.ok(ev.some((e) => e.kind === "edit" && e.agent === "fixer"));
  const planSeen: string[][] = []; const d2 = repo(); put(d2, ".amness/agents/fixer.md", agentMd("fixer", "tools: read_file, edit_file, sh", "You are careful."));
  const a2 = lead(d2, [call("task", { description: "x", agent: "fixer" }), { role: "assistant", content: "ok" }], async (_m, s) => (planSeen.push(s.map((x) => x.name)), call("finish", { summary: "looked" })), { permissions: { mode: () => "plan" } });
  await a2.chat([], "go"); assert.ok(planSeen[0].includes("read_file") && !planSeen[0].includes("edit_file") && !planSeen[0].includes("sh"));
});

test("task tool: isolation: worktree leaves the working tree alone, saves a patch, and apply_patch can apply it from the file", async () => {
  const d = repo(); put(d, ".amness/agents/fixer.md", agentMd("fixer", "tools: read_file, edit_file\nisolation: worktree", "You are careful."));
  let step = 0; const sub: Model = async () => [call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "one", new: "ISOLATED" }), call("finish", { summary: "edited in isolation" })][step++];
  const a = lead(d, [call("task", { description: "change a.txt", agent: "fixer" }), { role: "assistant", content: "ok" }], sub);
  const r = await a.chat([], "go"), out = r.messages.find((m) => m.role === "tool")!.content!;
  assert.match(out, /edited in isolation[\s\S]*isolated copy; nothing in your working tree has changed yet[\s\S]*\.amness\/agents\/out\/fixer-.*\.patch/);
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "one\n"); assert.ok(!git(d, "worktree", "list").includes("amness-wt"));
  const rel = /\.amness\/agents\/out\/[\w.-]+\.patch/.exec(out)![0]; assert.ok(readdirSync(join(d, ".amness/agents/out")).length === 1);
  const tools = (a.registry as any).tools as Map<string, any>, read = tools.get("read_file"), patch = tools.get("apply_patch"), ctx = { registry: a.registry, step: 0 };
  await read.run({ path: "a.txt" }, ctx); assert.match(String(await patch.run({ file: rel }, ctx)), /patched 1 file\(s\)[\s\S]*updated a\.txt/); assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "ISOLATED\n");
  const none = repo(); put(none, ".amness/agents/fixer.md", agentMd("fixer", "tools: edit_file\nisolation: worktree")); const nonGit = root(); put(nonGit, ".amness/agents/fixer.md", agentMd("fixer", "tools: edit_file\nisolation: worktree"));
  const a3 = lead(nonGit, [call("task", { description: "x", agent: "fixer" }), { role: "assistant", content: "ok" }], async () => call("finish", { summary: "n" }));
  assert.match((await a3.chat([], "go")).messages.find((m) => m.role === "tool")!.content!, /needs a git repository/);
});

test("task tool: at most 3 subagents run at once, and a subagent's report is clipped", async () => {
  const d = repo(); let live = 0, peak = 0;
  const sub: Model = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 40)); live--; return call("finish", { summary: "x".repeat(20000) }); };
  const a = createCodeAgent({ model: async (m, s) => ((m[0].content ?? "").includes("read-only code explorer") ? sub(m, s) : leadQ.shift()!), cwd: d, memory: false, chat: true, permissions: { mode: () => "default" }, index: false, guidance: false });
  const leadQ: Message[] = [{ role: "assistant", content: null, tool_calls: Array.from({ length: 5 }, (_, i) => ({ id: "t" + i, function: { name: "task", arguments: JSON.stringify({ description: "look " + i }) } })) }, { role: "assistant", content: "done" }];
  const r = await a.chat([], "go");
  assert.equal(peak, 3); const outs = r.messages.filter((m) => m.role === "tool").map((m) => m.content!); assert.equal(outs.length, 5); assert.ok(outs.every((o) => o.length < 9000));
});

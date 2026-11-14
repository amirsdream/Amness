import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "../src/index.ts";
import { BackgroundTasks } from "../cli/tui/background.ts";
import { DesktopBridge, type ServerEvent } from "../cli/desktop/bridge.ts";
import { cloneConfig, loadConfig, saveConfig } from "../cli/config.ts";
import { KEY, call, gate, rig, say, sleep } from "./helpers/apprig.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString();
const repo = () => { const d = mkdtempSync(join(tmpdir(), "amness-mt-")); writeFileSync(join(d, "a.txt"), "one\n"); writeFileSync(join(d, ".gitignore"), ".amness/\n"); git(d, "init", "-q"); git(d, "add", "."); git(d, "commit", "-qm", "init"); return d; };
const until = async (f: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

test("two windows saving the config each keep the other's change (only changed keys are written)", () => {
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  const a = loadConfig(), b = loadConfig();
  a.theme = "daylight"; saveConfig(a);
  b.model = "other-model"; saveConfig(b);
  const disk = JSON.parse(readFileSync(join(process.env.AMNESS_HOME!, "config.json"), "utf8"));
  assert.equal(disk.theme, "daylight"); assert.equal(disk.model, "other-model");
  const c = cloneConfig(b); c.provider = "ollama"; c.baseUrl = "http://localhost:11434/v1"; saveConfig(c);
  const disk2 = JSON.parse(readFileSync(join(process.env.AMNESS_HOME!, "config.json"), "utf8"));
  assert.equal(disk2.provider, "ollama"); assert.equal(disk2.theme, "daylight");
});

test("background tasks: each runs in its own worktree; apply brings its change into the working tree; drop removes it; outside git it is refused", async (t) => {
  const d = repo(), ended: number[] = [];
  const g = gate();
  t.after(() => g.open());   // a failed check must not leave the tasks waiting (on Windows the file then hung until the CI timeout)
  const bg = new BackgroundTasks({ cwd: d, maxTokens: () => 100000, onEnd: (t) => ended.push(t.id),
    run: async ({ dir, task }) => { await g.p; writeFileSync(join(dir, "a.txt"), `${task}\n`); return { text: `did ${task}`, finished: true, steps: 2 }; } });
  const t1 = await bg.start("two"), t2 = await bg.start("three");
  assert.notEqual(t1.dir, t2.dir); assert.match(t1.dir, /\.amness[\\/]worktrees[\\/]bg-1-/);
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "one\n", "your files are untouched while they run");
  assert.match(await bg.apply(1), /still running/);
  g.open(); assert.ok(await until(() => ended.length === 2));
  assert.deepEqual(bg.get(1)!.changed, ["a.txt"]); assert.equal(bg.get(1)!.status, "done");
  assert.match(await bg.apply(1), /^applied task 1/); assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "two\n"); assert.ok(!existsSync(t1.dir));
  assert.equal(await bg.drop(2), "dropped task 2"); assert.ok(!existsSync(t2.dir));
  await assert.rejects(new BackgroundTasks({ cwd: mkdtempSync(join(tmpdir(), "amness-nogit-")), maxTokens: () => 1, run: async () => ({ text: "", finished: true, steps: 0 }) }).start("x"), /need a git repository/);
});

test("/bg in the app: a task runs in the background while the chat stays free, and its end is announced", async (ctx) => {
  const g = gate();
  ctx.after(() => g.open());
  const route = async (m: Message[]) => { if (/worktrees[\\/]bg-/.test(m[0].content ?? "")) { await g.p; return call("finish", { summary: "background work done" }); } return say("here, still free"); };
  const t = rig(Array(20).fill(route)); git(t.dir, "init", "-q"); writeFileSync(join(t.dir, ".gitignore"), ".amness/\n"); git(t.dir, "add", "."); git(t.dir, "commit", "-qm", "init");
  await t.start();
  await t.submit("/bg tidy the readme"); assert.ok(await until(() => t.has(/started background task 1/)));
  await t.submit("hello"); assert.ok(await until(() => t.has("here, still free")), "the chat answers while the task runs");
  await t.submit("/bg"); await t.settle(); assert.ok(t.has(/1\. tidy the readme +· running/));
  g.open(); assert.ok(await until(() => t.has(/background task 1 finished: background work done/)));
  await t.submit("/bg drop 1"); assert.ok(await until(() => t.has("dropped task 1")));
});

test("desktop: a new chat while one works keeps the first alive, in its own worktree; the first one's end is announced; it can be brought back", async (t) => {
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  const d = repo(), g = gate(), events: ServerEvent[] = [];
  writeFileSync(join(process.env.AMNESS_HOME, "state.json"), JSON.stringify({ verifyByDir: {}, tasks: [], trustedDirs: [d] }));
  const model: Model = async (m) => { const u = [...m].reverse().find((x) => x.role === "user")?.content ?? ""; if (/slow job/.test(u)) { await g.p; return say("slow job done"); } return say("quick answer"); };
  let b: DesktopBridge | undefined;
  t.after(() => { g.open(); b?.close(); });
  b = new DesktopBridge({ cfg: { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "test-model", maxTokens: 100000 } as any, cwd: d, version: "0", persist: false, makeModel: () => model, emit: (e) => events.push(e) });
  await sleep(80);
  b.send("please do the slow job"); assert.ok(await until(() => b.app.running));
  const first = b.app, firstId = first.session.id;
  await b.newConversation();
  assert.notEqual(b.app, first); assert.ok(first.running, "the first chat keeps working");
  assert.match(b.app.cwd, /\.amness[\\/]worktrees[\\/]chat-1-/);
  const live = b.state().live; assert.equal(live.length, 2); assert.ok(live.some((l) => l.id === firstId && l.running && !l.current));
  b.send("a quick question"); assert.ok(await until(() => b.app.blocks.blocks.some((x: any) => x.kind === "assistant" && /quick answer/.test(x.text ?? ""))));
  g.open(); assert.ok(await until(() => events.some((e) => e.type === "toast" && /finished/.test(e.text))));
  await b.resume(firstId); assert.equal(b.app, first);
  assert.ok(b.app.blocks.blocks.some((x: any) => /slow job done/.test(x.text ?? "")));
  b.close();
});

async function mock(replies: object[]) {
  const srv = createServer((req, res) => { let s = ""; req.on("data", (x) => (s += x)); req.on("end", () => { if (!req.url?.endsWith("/chat/completions")) { res.statusCode = 404; return void res.end("{}"); } res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: replies.shift() ?? { role: "assistant", content: "done" } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, close: () => srv.close() };
}
const tc = (id: string, name: string, args: object) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const cli = (args: string[], cwd: string, env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((ok) => {
  const p = spawn("node", ["--no-warnings", join(process.cwd(), "cli/amness.ts"), ...args], { cwd, env: { ...process.env, NO_COLOR: "1", AMNESS_NOTIFY: "off", ...env } });
  let out = ""; p.stdout.on("data", (x) => (out += x)); p.stderr.on("data", (x) => (out += x)); p.on("close", (code) => ok({ code, out }));
});

test("amness run --background: returns at once, works in its own worktree, records the outcome; amness tasks shows it and --apply takes the change", async () => {
  const d = repo(), home = mkdtempSync(join(tmpdir(), "amness-h-"));
  const api = await mock([tc("1", "write_file", { path: "b.txt", content: "made in the background\n" }), tc("2", "finish", { summary: "made b.txt" })]);
  try {
    const r = await cli(["run", "--background", "--provider", "custom", "--base-url", api.url, "--model", "m", "make b.txt"], d, { AMNESS_HOME: home });
    assert.equal(r.code, 0, r.out); const id = /started background run (\S+)/.exec(r.out)![1];
    assert.match(r.out, /on branch amness\/run-/);
    const rec = join(d, ".amness", "background", `${id}.json`);
    assert.ok(await until(() => { try { return JSON.parse(readFileSync(rec, "utf8")).status !== "running"; } catch { return false; } }, 20000));
    assert.equal(JSON.parse(readFileSync(rec, "utf8")).status, "done");
    assert.ok(!existsSync(join(d, "b.txt")), "your folder is untouched");
    const list = await cli(["tasks"], d, { AMNESS_HOME: home }); assert.match(list.out, new RegExp(`✓ ${id} +done +make b\\.txt`));
    const show = await cli(["tasks", id], d, { AMNESS_HOME: home }); assert.match(show.out, /made b\.txt/);
    const ap = await cli(["tasks", "--apply", id], d, { AMNESS_HOME: home }); assert.match(ap.out, /applied/, ap.out);
    assert.equal(readFileSync(join(d, "b.txt"), "utf8"), "made in the background\n");
  } finally { api.close(); }
});

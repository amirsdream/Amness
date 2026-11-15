// The Advanced view: full recording in the trace, size limits, the lifecycle model, pause points in the harness, and both front ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer, createHarness, defineTool, pruneTraces, readRequests, readTraceLines, type Message, type Model, type PauseEdit, type PausePoint, type TraceLine, type Event } from "../src/index.ts";
import { KIND, Lifecycle, BOXES } from "../cli/tui/lifecycle.ts";
import { AdvancedView, PauseBook, advancedData, pauseOp } from "../cli/tui/advanced.ts";
import { advancedLines, drawAdvanced } from "../cli/tui/advancedview.ts";
import { Canvas } from "../cli/tui/canvas.ts";
import { getTheme } from "../cli/tui/themes.ts";
import { KEY, call, rig, say, sleep } from "./helpers/apprig.ts";

let n = 0;
const tc = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `p${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const echo = defineTool<{ x: string }>({ name: "echo", description: "echo", schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } }, run: ({ x }) => `got ${x}` });
const tmp = () => mkdtempSync(join(tmpdir(), "amness-adv-"));

test("full recording: requests are written once per change and rebuilt exactly; thinking, diffs and every event field are kept", () => {
  const lines: TraceLine[] = []; let full = false;
  const tr = new Tracer({ sessionId: "s", sink: (l) => lines.push(l), full: () => full });
  const sys: Message = { role: "system", content: "SYSTEM" }, u: Message = { role: "user", content: "task" }, a: Message = { role: "assistant", content: "hi" };
  tr.request({ step: 0, messages: [sys, u], tools: [{ name: "echo" }] as any });
  assert.equal(lines.length, 0, "nothing written while full recording is off");
  full = true;
  tr.request({ step: 0, messages: [sys, u], tools: [{ name: "echo" }] as any });
  tr.request({ step: 1, messages: [sys, u, a, { role: "user", content: "more" }], tools: [{ name: "echo" }] as any });
  assert.equal(lines.filter((l) => l.kind === "blob").length, 2, "system prompt and tool list written once");
  const req = lines.filter((l) => l.kind === "request");
  assert.deepEqual([req[1].keep, (req[1].add as unknown[]).length], [1, 2], "the second request keeps the shared message and adds two");
  const rebuilt = [...readRequests(lines).values()];
  assert.deepEqual(rebuilt[1].messages.map((m) => m.content), ["SYSTEM", "task", "hi", "more"]);
  assert.deepEqual(rebuilt[1].tools, [{ name: "echo" }]);
  tr.event({ kind: "thinking", delta: "let me " }); tr.event({ kind: "thinking", delta: "think" }); tr.event({ kind: "assistant", text: "ok", streamed: true });
  assert.equal(lines.find((l) => l.kind === "thinking")?.text, "let me think");
  tr.event({ kind: "edit", path: "a.txt", created: false, added: 1, removed: 0, diff: "+x", before: "old" });
  assert.deepEqual([lines.at(-1)!.diff, lines.at(-1)!.before], ["+x", "old"]);
  tr.event({ kind: "review", pass: false, findings: ["missing test"] } as Event);
  assert.deepEqual(lines.at(-1)!.findings, ["missing test"], "a review keeps its findings, not only a detail line");
  full = false; tr.event({ kind: "edit", path: "a.txt", created: false, added: 1, removed: 0, diff: "+x" });
  assert.equal(lines.at(-1)!.diff, undefined, "diffs only in full mode");
});

test("trace storage limit: the oldest traces go first and the current one stays", () => {
  const d = tmp(), mk = (f: string, kb: number, age: number) => { const p = join(d, f); writeFileSync(p, "x".repeat(kb * 1024)); const t = Date.now() / 1000 - age; utimesSync(p, t, t); return p; };
  const old = mk("old.jsonl", 40, 300), mid = mk("mid.jsonl", 40, 200), cur = mk("cur.jsonl", 40, 400);
  assert.equal(pruneTraces(d, 90 * 1024, cur), 1);
  assert.ok(!existsSync(old) && existsSync(mid) && existsSync(cur), "the oldest that is not the current one went");
  assert.equal(pruneTraces(d, 0, cur), 0, "0 means no limit");
  void statSync;
});

test("lifecycle: every harness event kind has a box; chats and steps are numbered; details are built on demand", () => {
  const src = readFileSync(new URL("../src/harness.ts", import.meta.url), "utf8"), union = src.slice(src.indexOf("export type Event ="), src.indexOf("/** One hook command's run"));
  const kinds = [...union.matchAll(/kind: ((?:"[a-z]+"\s*\|?\s*)+);/g)].flatMap((m) => [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]));
  assert.ok(kinds.length > 30, `found ${kinds.length} kinds`);
  for (const k of kinds) assert.ok(k in KIND, `event kind "${k}" has no box in cli/tui/lifecycle.ts`);
  const L = new Lifecycle([
    { t: "2026-01-01T00:00:00Z", ms: 0, kind: "chat", text: "fix it" }, { t: "", ms: 1, kind: "run", messages: [] },
    { t: "", ms: 2, kind: "phase", phase: "model", step: 0 }, { t: "", ms: 3, kind: "turn", step: 0, prompt: 10, completion: 2, cached: 0, reasoning: 0, ms2: 1 },
    { t: "", ms: 4, kind: "toolstart", id: "a", name: "sh", args: '{"cmd":"ls"}' }, { t: "", ms: 5, kind: "tool", id: "a", name: "sh", ok: true, result: "x" },
    { t: "", ms: 6, kind: "phase", phase: "model", step: 1 }, { t: "", ms: 7, kind: "nudge", detail: "act" },
    { t: "", ms: 8, kind: "chat", text: "again" }, { t: "", ms: 9, kind: "run", messages: [] }, { t: "", ms: 10, kind: "finish", summary: "done" },
    { t: "", ms: 11, kind: "toolstart", id: "b", name: "read_file", args: "{}", agent: "explore" },
  ]);
  assert.equal(L.chats.length, 2, "a chat line and its run are one chat");
  assert.deepEqual(L.frames.map((f) => [f.box, f.chat, f.step]), [["you", 1, 0], ["you", 1, 0], ["model", 1, 1], ["tools", 1, 1], ["tools", 1, 1], ["guards", 1, 2], ["you", 2, 0], ["you", 2, 0], ["answer", 2, 0], ["tools", 2, 0]]);
  assert.equal(L.frames.at(-1)!.agent, "explore");
  assert.match(L.detailOf(3).map((s) => s.body).join("\n"), /"cmd": "ls"/);
  assert.deepEqual(BOXES.map((b) => b.id), ["you", "hooks", "context", "model", "tools", "guards", "finish", "answer"]);
});

/** A harness run with a pause handler that answers from a script, recording the points it was asked at. */
async function pausedRun(replies: Message[], answer: (p: PausePoint) => PauseEdit | undefined) {
  const points: PausePoint[] = [], events: Event[] = [], seen: Message[][] = [];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return replies.shift() ?? say("(none)"); };
  const r = await createHarness({ model, tools: [echo], onEvent: (e) => events.push(e), pause: async (p) => { points.push(structuredClone(p)); return answer(p); } }).run("task");
  return { r, points, events, seen };
}

test("pause points: every point is offered; edited arguments and results reach the model; each change is an override event", async () => {
  const { r, points, events, seen } = await pausedRun([tc("echo", { x: "a" }), tc("finish", { summary: "ok" })], (p) =>
    p.at === "tool" ? { args: { x: "b" } } : p.at === "result" ? { result: `${p.result} (checked)` } : p.at === "model" && p.step === 0 ? { note: "be brief", maxSteps: 9 } : undefined);
  assert.equal(r.finished, true);
  assert.deepEqual(points.map((p) => p.at), ["model", "reply", "tool", "result", "model", "reply", "finish"]);
  assert.equal(seen[0].at(-1)!.content, "be brief", "the note went before the first call");
  assert.equal(seen[1].find((m) => m.role === "tool")!.content, "got b (checked)", "the edited arguments ran, and the edited result is what the model saw");
  assert.deepEqual(events.filter((e) => e.kind === "override").map((e) => (e as { detail: string }).detail), ["step limit 9; added a note", "edited the arguments", "edited the result"]);
});

test("pause points: skip, deny, reject and accept at a finish, edited tool calls, and guards switched off", async () => {
  const skip = await pausedRun([tc("echo", { x: "a" }), tc("finish", { summary: "ok" })], (p) => (p.at === "tool" ? { skip: "not now" } : undefined));
  assert.match(skip.seen[1].find((m) => m.role === "tool")!.content!, /^SKIPPED by the user: not now/);
  const deny = await pausedRun([tc("echo", { x: "a" }), tc("finish", { summary: "ok" })], (p) => (p.at === "tool" ? { deny: "no" } : undefined));
  assert.match(deny.seen[1].find((m) => m.role === "tool")!.content!, /^DENIED by the user: no/);
  let finishes = 0;
  const fin = await pausedRun([tc("finish", { summary: "first" }), tc("finish", { summary: "second" })], (p) => (p.at === "finish" ? (++finishes === 1 ? { reject: "add a test" } : { accept: true }) : undefined));
  assert.equal(fin.r.text, "second"); assert.match(fin.seen[1].at(-1)!.content!, /REJECTED by the user: add a test/);
  const calls = await pausedRun([say("I will look"), tc("finish", { summary: "done" })], (p) => (p.at === "reply" && p.step === 0 ? { calls: [{ id: "", name: "echo", args: '{"x":"z"}' }] } : undefined));
  assert.equal(calls.seen[1].find((m) => m.role === "tool")!.content, "got z", "a reply with no calls was given one");
  const g = await pausedRun([tc("echo", { x: "a" }), tc("echo", { x: "a" }), tc("echo", { x: "a" }), tc("finish", { summary: "ok" })], (p) => (p.at === "model" && p.step === 0 ? { off: ["loop"] } : undefined));
  assert.ok(!g.seen.at(-1)!.some((m) => /exact call/.test(m.content ?? "")), "the loop guard stayed quiet after it was switched off");
  const none = await pausedRun([tc("echo", { x: "a" }), tc("finish", { summary: "ok" })], () => undefined);
  assert.equal(none.events.filter((e) => e.kind === "override").length, 0, "no change, no override");
});

test("pause book and actions: once is used up; bad values are refused with a reason", () => {
  const b = new PauseBook(); assert.equal(b.cycle("hooks"), undefined, "hooks have no pause points");
  assert.equal(b.cycle("tools"), "always"); assert.equal(b.cycle("tools"), "once");
  const p: PausePoint = { at: "tool", step: 0, id: "x", name: "echo", args: { x: "a" } };
  assert.equal(b.take(p), true); assert.equal(b.take(p), false, "a once pause is used once");
  let got: PauseEdit | undefined | null = null; b.waiting = { point: p, box: "tools", edit: {}, since: 0, resolve: (e) => { got = e; } };
  assert.match(pauseOp(b, { op: "set", field: "args", text: "{bad" })!, /not valid JSON/);
  assert.match(pauseOp(b, { op: "set", field: "note", text: "x" })!, /before a model call/);
  assert.match(pauseOp(b, { op: "guard", guard: "nope", on: false })!, /no guard called nope/);
  assert.equal(pauseOp(b, { op: "set", field: "args", text: '{"x":"b"}' }), undefined);
  assert.equal(pauseOp(b, { op: "continue" }), undefined); assert.deepEqual(got, { args: { x: "b" } });
  assert.match(pauseOp(b, { op: "continue" })!, /not paused/);
});

test("view: moving by frame, step, chat and box; filters; drawn on a canvas and as lines", () => {
  const lines: TraceLine[] = [{ t: "2026-01-01T00:00:00Z", ms: 0, kind: "chat", text: "one" }];
  for (let s = 0; s < 3; s++) lines.push({ t: "2026-01-01T00:00:00Z", ms: s, kind: "phase", phase: "model", step: s }, { t: "2026-01-01T00:00:00Z", ms: s, kind: "toolstart", id: `t${s}`, name: "sh", args: "{}" }, { t: "2026-01-01T00:00:00Z", ms: s, kind: "tool", id: `t${s}`, name: "sh", ok: s !== 1, result: s === 1 ? "ERROR: x" : "ok" });
  lines.push({ t: "2026-01-01T00:00:00Z", ms: 9, kind: "chat", text: "two" }, { t: "2026-01-01T00:00:00Z", ms: 9, kind: "finish", summary: "done" });
  const v = new AdvancedView(lines, { live: false, title: "t", file: "t.jsonl" });
  assert.equal(v.frame!.title, "Finished");
  v.home(); assert.equal(v.cur, 0); v.move(1); assert.equal(v.frame!.title, "Call sh");
  v.step(1); assert.equal(v.frame!.step, 2); v.step(-1); assert.equal(v.frame!.step, 1);
  v.chat(1); assert.equal(v.frame!.chat, 2); v.chat(-1); assert.equal(v.frame!.chat, 1);
  v.home(); v.jumpBox("answer"); assert.equal(v.frame!.box, "answer");
  v.filter = "tools"; v.home(); v.move(1); assert.equal(v.frame!.box, "tools");
  const book = new PauseBook(), d = advancedData(v, book);
  assert.ok(d.timeline.some((x) => x.tone === "err"), "the failed call shows on the timeline");
  const c = new Canvas(120, 40, 0); drawAdvanced(c, getTheme(), v, book);
  const screen = Array.from({ length: 40 }, (_, y) => c.readRow(y)).join("\n");
  assert.match(screen, /Advanced/); assert.match(screen, /Model/); assert.match(screen, /Guards/);
  assert.match(advancedLines(v, book, 80, 20).join("\n"), /Advanced/);
});

test("terminal: /advanced opens over the chat, a pause on Tools stops the run before the call, c lets it go on", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("finish", { summary: "read it" })], { ui: "full", cols: 130, rows: 40, cfg: { mode: "yolo" } });
  await t.start(); t.app.setMode("yolo");
  await t.submit("/advanced");
  assert.ok(await t.until(() => /Advanced/.test(t.screen()) && /Guards/.test(t.screen())), t.screen());
  await t.key(KEY.tab); await t.type("b");                                              // focus moves from Model to Tools; b sets a pause there
  assert.equal(t.app.pauses.boxes.get("tools"), "always");
  await t.key(KEY.esc); assert.equal(t.app.advanced, null);
  await t.submit("read a.txt");
  assert.ok(await t.until(() => !!t.app.pauses.waiting), "the run paused");
  assert.equal(t.app.pauses.waiting!.point.at, "tool"); assert.ok(t.app.advanced, "a pause opens the view again");
  assert.ok(await t.until(() => /Paused/.test(t.screen())), t.screen());
  t.app.pauses.boxes.clear(); await t.type("c");
  assert.ok(await t.until(() => t.idle()), "the run finished after c");
  assert.ok(t.app.traceBuf.some((l) => l.kind === "request"), "full recording was on while the view was open");
  await t.key(KEY.esc); await t.key(KEY.ctrlD);
});

test("terminal inline: the Advanced view draws as lines and closes with Esc", async () => {
  const t = rig([say("hello")], { ui: "inline" }); await t.start();
  await t.submit("hi"); assert.ok(await t.until(() => t.idle()));
  await t.submit("/advanced"); assert.ok(await t.until(() => /◆ Advanced/.test(t.screen())), t.screen());
  await t.key(KEY.left); await t.key(KEY.esc); assert.equal(t.app.advanced, null);
  await t.key(KEY.ctrlD);
});

void sleep; void readTraceLines;

test("desktop: /advanced sends the view as data; a pause set from the window stops the run; acting from the window lets it go on", async (t) => {
  const { startDesktopServer } = await import("../cli/desktop/server.ts");
  const { mkdirSync } = await import("node:fs");
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  const dir = tmp(); mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "a.txt"), "one\n");
  const queue: Message[] = [call("read_file", { path: "a.txt" }), call("finish", { summary: "read it" })];
  const model: Model = async () => queue.shift() ?? say("(done)");
  const srv = await startDesktopServer({ cfg: { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "test-model", maxTokens: 100000 } as any, cwd: dir, version: "0.0.0", persist: false, makeModel: () => model } as any);
  const base = srv.url.split("/#")[0], events: any[] = [], ctrl = new AbortController();
  t.after(async () => { ctrl.abort(); await srv.close(); });
  const es = await fetch(`${base}/events?t=${srv.token}`, { signal: ctrl.signal });
  void (async () => { const rd = es.body!.getReader(), dec = new TextDecoder(); let buf = ""; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); if (c.startsWith("data: ")) events.push(JSON.parse(c.slice(6))); } } } catch { /* closed */ } })();
  const api = async (path: string, body?: unknown) => (await fetch(base + path, { method: "POST", headers: { "x-amness-token": srv.token, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
  const until = async (f: () => boolean, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
  const view = () => [...events].reverse().find((e) => e.type === "advanced")?.view;
  await sleep(60);
  await api("/api/mode", { mode: "yolo" });
  await api("/api/send", { text: "/advanced" });
  assert.ok(await until(() => !!view()), "the view arrived");
  assert.deepEqual(view().boxes.map((b: { id: string }) => b.id), ["you", "hooks", "context", "model", "tools", "guards", "finish", "answer"]);
  assert.deepEqual(await api("/api/advanced", { op: "pause", box: "tools" }), { ok: true });
  assert.ok(await until(() => view()?.boxes.find((b: { id: string }) => b.id === "tools").pause === "always"));
  await api("/api/send", { text: "read a.txt" });
  assert.ok(await until(() => view()?.paused?.at === "tool"), "paused before the call");
  assert.equal(view().paused.target.field, "args");
  const bad = await api("/api/advanced", { op: "act", act: { op: "set", field: "args", text: "{oops" } });
  assert.equal(bad.ok, false); assert.match(bad.error, /not valid JSON/);
  await api("/api/advanced", { op: "pause", box: "tools" }); await api("/api/advanced", { op: "pause", box: "tools" });       // always → once → off
  assert.deepEqual(await api("/api/advanced", { op: "act", act: { op: "continue" } }), { ok: true });
  assert.ok(await until(() => !view()?.paused && view()?.list.some((f: { title: string }) => f.title === "Finished")), "the run went on and finished");
  await api("/api/advanced", { op: "close" });
  assert.ok(await until(() => view() === null), "closing sends null");
});

test("subagents pause too, one at a time, with their name; the u switch turns that off", async (tt) => {
  const t = rig([call("task", { description: "look at a.txt" }), call("read_file", { path: "a.txt" }), call("finish", { summary: "a.txt has two lines" }), call("finish", { summary: "done" })], { cfg: { mode: "yolo" } });
  await t.start(); t.app.setMode("yolo");
  t.app.pauses.boxes.set("tools", "always");
  const seen: string[] = [];
  const pump = setInterval(() => { const w = t.app.pauses.waiting; if (w) { seen.push(`${w.point.agent ?? "lead"}:${w.point.at}:${"name" in w.point ? w.point.name : ""}`); t.app.pauses.release(); } }, 10);
  tt.after(() => clearInterval(pump));
  await t.submit("explore it");
  assert.ok(await t.until(() => t.idle() && seen.length >= 4, 8000), JSON.stringify(seen));
  assert.ok(seen.includes("lead:tool:task") && seen.includes("explore:tool:read_file") && seen.includes("explore:result:read_file"), JSON.stringify(seen));
  seen.length = 0; t.app.pauses.subagents = false;
  (t.app as any).pauseNow = undefined;                                                    // not used: only checks that pauseAt refuses before queueing
  assert.equal(t.app.pauseAt({ at: "tool", step: 0, id: "x", name: "read_file", args: {}, agent: "explore" }), undefined, "a subagent does not pause with the switch off");
  await t.key(KEY.ctrlD);
});

test("replay a chat with the current harness, and fork a new chat from a recorded request", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("finish", { summary: "read it" })], { ui: "full", cols: 130, rows: 40, cfg: { mode: "yolo" } });
  await t.start(); t.app.setMode("yolo");
  await t.submit("/advanced"); await t.key(KEY.esc);
  t.app.openAdvanced();                                                                    // full recording is on while it is open
  t.app.closeAdvanced(); (t.app.cfg as any).fullTrace = true;
  await t.submit("read a.txt"); assert.ok(await t.until(() => t.idle()));
  t.app.openAdvanced();
  await t.app.replayChat();
  assert.match(t.app.advanced!.source.title, /^replay of chat 1: same as recorded/, String(t.app.advanced!.lc.lines[0].detail));
  assert.equal(t.app.advanced!.frames[0].title, "Replay report");
  assert.ok(t.app.advanced!.frames.some((f) => f.kind === "request"), "the replay is recorded in full");
  t.app.openAdvanced(); const v = t.app.advanced!;
  v.go(v.frames.findIndex((f) => f.kind === "request" && f.step === 2));
  const before = t.app.session.id; t.app.forkHere();
  assert.notEqual(t.app.session.id, before); assert.match(t.app.session.title, /^Fork of .* at step 2$/);
  assert.equal(t.app.session.messages[0].role, "system"); assert.equal(t.app.session.messages.at(-1)!.role, "tool", "it starts after the read, where the model was");
  assert.equal(t.app.advanced, null);
  await t.key(KEY.ctrlD);
});

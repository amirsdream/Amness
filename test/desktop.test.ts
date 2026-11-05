import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "../src/index.ts";
import { startDesktopServer } from "../cli/desktop/server.ts";
import { electronBinary } from "../cli/desktop.ts";
import { call, say, sleep } from "./helpers/apprig.ts";

/** A desktop server over a temp project with a scripted model, plus a reader for its event stream. */
async function boot(replies: Message[], files: Record<string, string> = { "a.txt": "one\ntwo\n" }) {
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  const dir = mkdtempSync(join(tmpdir(), "amness-desk-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const queue = [...replies];
  const model: Model = async (_m, _s, o) => { const r = queue.shift() ?? say("(done)"); if (r.content && o?.onText) o.onText(r.content); return r; };
  const srv = await startDesktopServer({ cfg: { provider: "custom", baseUrl: "http://x/v1", model: "test-model", maxTokens: 100000 } as any, cwd: dir, version: "0.0.0", persist: false, makeModel: () => model });
  await sleep(50);
  const base = srv.url.split("/#")[0], events: any[] = [], ctrl = new AbortController();
  const es = await fetch(`${base}/events?t=${srv.token}`, { signal: ctrl.signal });
  void (async () => { const rd = es.body!.getReader(), dec = new TextDecoder(); let buf = ""; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6))); } } } catch { /* closed */ } })();
  const api = async (path: string, body?: unknown, token = srv.token) => { const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "x-amness-token": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const until = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
  const close = async () => { ctrl.abort(); await srv.close(); };
  return { srv, base, dir, events, api, until, close };
}

test("desktop server: the page loads with a strict CSP; the API and the event stream refuse requests without the token or from another site", async () => {
  const d = await boot([]);
  try {
    const page = await fetch(d.base + "/");
    assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/); assert.match(await page.text(), /<script src="app.js">/);
    assert.equal((await fetch(d.base + "/app.js")).status, 200);
    assert.equal((await d.api("/api/state", undefined, "wrong")).status, 401);
    assert.equal((await fetch(`${d.base}/events?t=wrong`)).status, 401);
    assert.equal((await fetch(d.base + "/api/state", { headers: { "x-amness-token": d.srv.token, origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(d.base + "/../package.json")).status, 404);
    const st = await d.api("/api/state"); assert.equal(st.status, 200); assert.equal(st.json.model, "test-model"); assert.equal(st.json.mode, "default"); assert.equal(st.json.sidebar.model, "test-model");
  } finally { await d.close(); }
});

test("desktop: the window shows the terminal app's own App: a message streams back as blocks, an edit asks through the App's approval dialog, and choosing 1 applies it", async () => {
  const d = await boot([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "two", new: "2" }), say("Changed it.")]);
  try {
    await d.api("/api/send", { text: "change two to 2" });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog")), JSON.stringify(d.events.slice(-3)));
    const dlg = d.events.find((e) => e.type === "dialog").dialog;
    assert.equal(dlg.kind, "choice"); assert.equal(dlg.detail.kind, "diff"); assert.match(dlg.detail.diff, /-two/); assert.match(dlg.options[0].label, /Yes/);
    assert.equal(readFileSync(join(d.dir, "a.txt"), "utf8"), "one\ntwo\n");
    await d.api("/api/dialog", { id: dlg.id, value: 0 });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "state" && !e.state.running && e.state.session.turns === 1)));
    assert.equal(readFileSync(join(d.dir, "a.txt"), "utf8"), "one\n2\n");
    assert.ok(d.events.some((e) => e.type === "dialogClose" && e.id === dlg.id));
    assert.ok(d.events.some((e) => e.type === "fileChanged" && e.path === "a.txt"));
    const blocks = new Map<number, any>(); for (const e of d.events) { if (e.type === "blocks") { blocks.clear(); for (const b of e.blocks) blocks.set(b.id, b); } if (e.type === "block") blocks.set(e.block.id, e.block); }
    assert.deepEqual([...blocks.values()].map((b) => b.kind).filter((k) => k !== "thinking"), ["user", "tool", "tool", "assistant"]);
    const st = (await d.api("/api/state")).json;
    assert.deepEqual(st.sidebar.changes.map((c: any) => c.path), ["a.txt"]); assert.ok(st.sidebar.loop.steps.length >= 3); assert.ok(st.loop.lines.length > 1);
    assert.equal(st.sidebar.usage.calls, 3);
  } finally { await d.close(); }
});

test("desktop: every terminal command works, its output arrives in colour, and completion is the terminal's own", async () => {
  const d = await boot([]);
  try {
    const cmds = (await d.api("/api/commands")).json; assert.ok(cmds.length > 50); assert.ok(cmds.some((c: any) => c.name === "loop" && c.group));
    await d.api("/api/send", { text: "/status" });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "block" && e.block.kind === "raw")));
    const raw = d.events.find((e) => e.type === "block" && e.block.kind === "raw").block;
    assert.ok(raw.lines.some((l: string) => /\x1b\[/.test(l)), "command output keeps its colours");
    const s1 = (await d.api("/api/suggest", { text: "/sta", cursor: 4 })).json; assert.equal(s1.token.kind, "slash"); assert.ok(s1.items.some((i: any) => i.label === "/status"));
    const s2 = (await d.api("/api/suggest", { text: "/mode p", cursor: 7 })).json; assert.equal(s2.token.kind, "arg"); assert.ok(s2.items.some((i: any) => i.label === "plan"));
    const s3 = (await d.api("/api/suggest", { text: "read @a.t", cursor: 9 })).json; assert.equal(s3.token.kind, "file"); assert.ok(s3.items.some((i: any) => i.label === "a.txt"));
    await d.api("/api/send", { text: "/help" });                                      // a text dialog (the same help as the terminal), closed from the window
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog" && e.dialog.kind === "text")));
    const help = d.events.find((e) => e.type === "dialog" && e.dialog.kind === "text").dialog;
    await d.api("/api/dialog", { id: help.id, value: null });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialogClose" && e.id === help.id)));
    await d.api("/api/send", { text: "#prefer pnpm in this project" });
    assert.ok(await d.until(() => (d.srv.bridge.state().sidebar.memory ?? 0) >= 1));
  } finally { await d.close(); }
});

test("desktop: a picker dialog (/model) is answered with an item; declining an approval asks what to do instead, through the same dialogs", async () => {
  const seen: Message[][] = [];
  const d = await boot([call("sh", { cmd: "rm -rf build" }), say("ok, I will not")]);
  try {
    await d.api("/api/send", { text: "/mode" });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog" && e.dialog.kind === "pick")));
    const pick = d.events.find((e) => e.type === "dialog" && e.dialog.kind === "pick").dialog;
    await d.api("/api/dialog", { id: pick.id, value: pick.items.findIndex((i: any) => /plan/.test(i.label)) });
    assert.ok(await d.until(() => d.srv.bridge.state().mode === "plan"));
    await d.api("/api/mode", { mode: "default" });
    const app = d.srv.bridge.app as any, chat = app.agent.chat.bind(app.agent); app.agent.chat = async (...a: any[]) => { const r = await chat(...a); seen.push(r.messages); return r; };
    await d.api("/api/send", { text: "clean up" });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog" && e.dialog.kind === "choice")));
    const ask = d.events.filter((e) => e.type === "dialog" && e.dialog.kind === "choice").at(-1).dialog;
    assert.equal(ask.detail?.kind ?? "command", "command");
    await d.api("/api/dialog", { id: ask.id, value: ask.options.length - 1 });           // "No, and tell Amness what to do instead"
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog" && e.dialog.kind === "input")));
    const why = d.events.find((e) => e.type === "dialog" && e.dialog.kind === "input").dialog;
    await d.api("/api/dialog", { id: why.id, value: "keep the build folder" });
    assert.ok(await d.until(() => seen.length === 1));
    assert.ok(seen[0].some((m) => m.role === "tool" && /keep the build folder/.test(m.content ?? "")));
    assert.equal((await d.api("/api/mode", { mode: "root" })).status, 400);
  } finally { await d.close(); }
});

test("desktop server: files are listed and read inside the project only; images are saved as mentions", async () => {
  const d = await boot([], { "a.txt": "hello\n", "b.md": "# b\n" });
  try {
    assert.deepEqual((await d.api("/api/files")).json.sort(), ["a.txt", "b.md"]);
    assert.equal((await d.api("/api/file?path=a.txt")).json.text, "hello\n");
    assert.equal((await d.api("/api/file?path=../../etc/passwd")).status, 400);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const r = await d.api("/api/image", { data: png }); assert.match(r.json.path, /^\.amness\/paste\/clip-.*\.png$/); assert.ok(existsSync(join(d.dir, r.json.path)));
    assert.equal((await d.api("/api/image", { data: Buffer.from("not an image").toString("base64") })).status, 400);
  } finally { await d.close(); }
});

test("desktop: the Electron program can be found (Electron downloads it the first time it is loaded)", () => {
  assert.ok(electronBinary(), "Electron could not be loaded or downloaded");
});

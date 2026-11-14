import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "../src/index.ts";
import { startDesktopServer } from "../cli/desktop/server.ts";
import { electronBinary } from "../cli/desktop.ts";
import { call, say, sleep } from "./helpers/apprig.ts";

/** A desktop server over a temp project with a scripted model, plus a reader for its event stream. */
async function boot(replies: Message[], files: Record<string, string> = { "a.txt": "one\ntwo\n" }, o: { cfg?: Record<string, unknown>; realModel?: boolean; persist?: boolean } = {}) {
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  const dir = mkdtempSync(join(tmpdir(), "amness-desk-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const queue = [...replies];
  const model: Model = async (_m, _s, o) => { const r = queue.shift() ?? say("(done)"); if (r.content && o?.onText) o.onText(r.content); return r; };
  const srv = await startDesktopServer({ cfg: { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "test-model", maxTokens: 100000, ...o.cfg } as any, cwd: dir, version: "0.0.0", persist: o.persist ?? false, makeModel: o.realModel ? undefined : () => model });
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

test("desktop: preferences are saved, including names with spaces (\"fold:Last run\"); names with other characters are refused", async () => {
  const d = await boot([]);
  try {
    const r = await d.api("/api/prefs", { "fold:Last run": true, "chats:Previous 30 days": false, theme: "light", "bad<name>": 1, ["x".repeat(81)]: 1 });
    assert.equal(r.json["fold:Last run"], true); assert.equal(r.json["chats:Previous 30 days"], false); assert.equal(r.json.theme, "light");
    assert.ok(!("bad<name>" in r.json)); assert.equal(Object.keys(r.json).length, 3);
    assert.deepEqual((await d.api("/api/prefs")).json, r.json);
    await d.api("/api/prefs", { theme: null }); assert.ok(!("theme" in (await d.api("/api/prefs")).json));   // null removes a preference
  } finally { await d.close(); }
});

test("desktop: editing a message by its bubble goes back to before it and resends the new text", async () => {
  const d = await boot([say("first answer"), say("second answer"), say("answer to the edit")]);
  try {
    await d.api("/api/send", { text: "first question" }); assert.ok(await d.until(() => d.srv.bridge.state().session.turns === 1 && !d.srv.bridge.state().running));
    await d.api("/api/send", { text: "second question" }); assert.ok(await d.until(() => d.srv.bridge.state().session.turns === 2 && !d.srv.bridge.state().running));
    const firstBubble = d.srv.bridge.app.blocks.blocks.find((b) => b.kind === "user" && b.text === "first question")!;
    const r = await d.api("/api/edit", { blockId: firstBubble.id, text: "a better first question" }); assert.equal(r.status, 200);
    assert.ok(await d.until(() => !d.srv.bridge.state().running && d.srv.bridge.app.session.turns.length === 1));
    assert.deepEqual(d.srv.bridge.app.session.turns.map((t) => t.text), ["a better first question"]);
    assert.ok(d.srv.bridge.app.blocks.blocks.some((b) => b.kind === "assistant" && b.text === "answer to the edit"));
    assert.equal((await d.api("/api/edit", { blockId: 99999, text: "x" })).status, 400);
  } finally { await d.close(); }
});

test("desktop: /todos edit and plan edits open the long-text dialog; harness settings are in Preferences' data", async () => {
  const d = await boot([call("exit_plan_mode", { plan: "1. Rewrite everything." }), say("ok")]);
  try {
    d.srv.bridge.app.todos = [{ content: "read", status: "pending" }];
    await d.api("/api/send", { text: "/todos edit" });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog" && e.dialog.kind === "longtext")));
    const dlg = d.events.find((e) => e.type === "dialog" && e.dialog.kind === "longtext").dialog;
    assert.equal(dlg.text, "- [ ] read");
    await d.api("/api/dialog", { id: dlg.id, value: "- [x] read\n- [ ] write" });
    assert.ok(await d.until(() => d.srv.bridge.app.todos.length === 2));
    d.srv.bridge.setMode("plan");
    await d.api("/api/send", { text: "plan it" });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "dialog" && e.dialog.kind === "choice" && e.dialog.detail?.kind === "plan")));
    const choice = d.events.filter((e) => e.type === "dialog" && e.dialog.kind === "choice").at(-1).dialog;
    await d.api("/api/dialog", { id: choice.id, value: choice.options.findIndex((o: any) => /edit the plan/.test(o.label)) });
    assert.ok(await d.until(() => d.events.filter((e) => e.type === "dialog" && e.dialog.kind === "longtext").length === 2));
    const planDlg = d.events.filter((e) => e.type === "dialog" && e.dialog.kind === "longtext").at(-1).dialog;
    assert.equal(planDlg.text, "1. Rewrite everything.");
    await d.api("/api/dialog", { id: planDlg.id, value: "1. Only fix the bug." });
    assert.ok(await d.until(() => !d.srv.bridge.state().running && d.srv.bridge.app.session.messages.some((m) => m.role === "tool" && /Only fix the bug/.test(m.content ?? ""))));
    await d.api("/api/command", { text: "/harness off loop" });
    const st = (await d.api("/api/settings")).json;
    assert.equal(st.harness.guards.find((g: any) => g.name === "loop").on, false); assert.equal(st.harness.maxSteps, 60);
  } finally { await d.close(); }
});

/** llama.cpp behind nginx: without the right bearer token nginx answers its HTML 401 page; with it, llama.cpp's /v1/models, /props and /v1/chat/completions. */
async function llamaBehindNginx(token?: string) {
  const seen: { path: string; auth?: string }[] = [];
  const srv = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      seen.push({ path: req.url!, auth: req.headers.authorization });
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { "content-type": "text/html" }); return void res.end("<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center><hr><center>nginx</center></body></html>"); }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/models") return void res.end(JSON.stringify({ object: "list", data: [{ id: "qwen-coder", object: "model" }] }));
      if (req.url === "/props") return void res.end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }));
      res.end(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "pong from llama.cpp" } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, seen, close: () => srv.closeAllConnections?.() ?? srv.close() };
}

/** The open dialog of this kind whose text matches, waiting for it. */
const dialogOf = async (d: Awaited<ReturnType<typeof boot>>, kind: string, re: RegExp) => {
  const find = () => d.events.find((e) => e.type === "dialog" && e.dialog.kind === kind && re.test(JSON.stringify(e.dialog)) && !d.events.some((x) => x.type === "dialogClose" && x.id === e.dialog.id))?.dialog;
  assert.ok(await d.until(() => !!find()), `no ${kind} dialog matching ${re}: ${JSON.stringify(d.events.filter((e) => e.type === "dialog").slice(-2))}`);
  return find();
};

test("desktop: a local server behind a token (llama.cpp + nginx) answers 401; the window asks for the key, saves it, and sends the message again with it", async () => {
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY_FILE;
  const llama = await llamaBehindNginx("srv-token");
  const d = await boot([], undefined, { cfg: { baseUrl: llama.url, model: "qwen-coder", api: "chat" }, realModel: true });
  try {
    await d.api("/api/send", { text: "ping" });
    const ask = await dialogOf(d, "input", /asks for a key/); assert.equal(ask.secret, true);
    await d.api("/api/dialog", { id: ask.id, value: "srv-token" });
    assert.ok(await d.until(() => JSON.stringify(d.events).includes("pong from llama.cpp"), 8000), "the message was sent again and answered");
    const chats = llama.seen.filter((s) => s.path === "/v1/chat/completions");
    assert.equal(chats[0].auth, undefined); assert.equal(chats.at(-1)!.auth, "Bearer srv-token");
    assert.equal((await import("../cli/config.ts")).keyFor("custom").key, "srv-token");
  } finally { if (saved) process.env.OPENAI_API_KEY = saved; llama.close(); await d.close(); }
});

test("desktop: /provider sets up a server through the window's dialogs (optional key skipped, model from its list, a name); requests go without a key, and the saved server is offered again", async () => {
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY_FILE;
  const llama = await llamaBehindNginx();
  const d = await boot([], undefined, { cfg: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", apiKey: "sk-x", api: "chat" }, realModel: true });
  try {
    await d.api("/api/send", { text: "/provider" });
    const pick = await dialogOf(d, "pick", /\+ Ollama server/);
    await d.api("/api/dialog", { id: pick.id, value: pick.items.findIndex((i: any) => /\+ Ollama server/.test(i.label)) });
    await d.api("/api/dialog", { id: (await dialogOf(d, "input", /base URL/)).id, value: llama.url });
    const key = await dialogOf(d, "input", /only if your server needs one/); assert.equal(key.secret, true);
    await d.api("/api/dialog", { id: key.id, value: "" });
    const model = await dialogOf(d, "pick", /qwen-coder/);                              // the model list comes from the server
    await d.api("/api/dialog", { id: model.id, value: model.items.findIndex((i: any) => i.label === "qwen-coder") });
    await d.api("/api/dialog", { id: (await dialogOf(d, "input", /Name for this server/)).id, value: "lab" });
    assert.ok(await d.until(() => /lab\S* saved and in use/.test(JSON.stringify(d.events))));
    await d.api("/api/send", { text: "ping" });
    assert.ok(await d.until(() => JSON.stringify(d.events).includes("pong from llama.cpp"), 8000));
    assert.ok(llama.seen.some((s) => s.path === "/v1/chat/completions") && llama.seen.every((s) => s.auth === undefined), JSON.stringify(llama.seen));
    await d.api("/api/send", { text: "/provider" });
    const again = await dialogOf(d, "pick", /"lab/);
    const row = again.items.find((i: any) => /lab/.test(i.label)); assert.match(row.label, /in use/); assert.match(row.hint, /Ollama · 127\.0\.0\.1:\d+\/v1 · qwen-coder · no key/);
    await d.api("/api/dialog", { id: again.id, value: null });
  } finally { if (saved) process.env.OPENAI_API_KEY = saved; llama.close(); await d.close(); }
});

test("desktop: a file outside the project asks in the window first; Yes reads it, and the folder is not asked about again", async () => {
  const lib = mkdtempSync(join(tmpdir(), "amness-lib-")); writeFileSync(join(lib, "x.ts"), "export const x = 'from lib';\n"); writeFileSync(join(lib, "y.ts"), "y\n");
  const d = await boot([call("read_file", { path: join(lib, "x.ts") }), call("read_file", { path: join(lib, "y.ts") }), say("Read both.")]);
  try {
    await d.api("/api/send", { text: "read the lib" });
    const ask = await dialogOf(d, "choice", /Outside this project/);
    assert.match(JSON.stringify(ask), /Allow Amness to use files in/); assert.equal(ask.options[0].label, "Yes, for this session");
    await d.api("/api/dialog", { id: ask.id, value: 0 });
    assert.ok(await d.until(() => JSON.stringify(d.events).includes("Read both."), 8000));
    assert.equal(d.events.filter((e) => e.type === "dialog" && /Outside this project/.test(JSON.stringify(e.dialog))).length, 1);   // y.ts is in the same folder
  } finally { await d.close(); }
});

test("desktop: a new folder asks whether you trust it; No while switching projects goes back to the project you had open", async () => {
  const d = await boot([], undefined, { persist: true });
  try {
    const first = await dialogOf(d, "choice", /Do you trust the files in this folder/);
    assert.deepEqual(first.options.map((x: any) => x.label), ["Yes, I trust this folder", "No"]);
    await d.api("/api/dialog", { id: first.id, value: 0 });
    const other = mkdtempSync(join(tmpdir(), "amness-other-"));
    await d.api("/api/project", { dir: other });
    const ask = await dialogOf(d, "choice", new RegExp(`${other.split(/[\\/]/).pop()}[\\s\\S]*Do you trust`));
    await d.api("/api/dialog", { id: ask.id, value: 1 });
    assert.ok(await d.until(() => d.events.some((e) => e.type === "toast" && /not opened: you did not trust/.test(e.text))));
    assert.ok(await d.until(() => !d.events.some((e) => e.type === "exit")));
    assert.equal((await d.api("/api/state")).json.cwd, d.dir);                          // back in the first project, window still open
    assert.ok(!(await d.api("/api/projects")).json.includes(other), "a folder you said no to leaves the recent list, so the next start does not open it and ask again");
  } finally { await d.close(); }
});

test("desktop: Preferences shows where each setting comes from and saves a change for this chat, this project or all projects", async () => {
  const d = await boot([], undefined, { persist: true });
  try {
    const trust = await dialogOf(d, "choice", /Do you trust the files in this folder/); await d.api("/api/dialog", { id: trust.id, value: 0 });
    const item = (st: any, id: string) => st.groups.flatMap((g: any) => g.items).find((x: any) => x.id === id);
    const local = join(d.dir, ".amness", "settings.local.json"), user = join(process.env.AMNESS_HOME!, "config.json");
    let r = (await d.api("/api/settings", { changes: [{ id: "review", value: true }] })).json;
    assert.ok(r.results[0].ok); assert.equal(item(r.settings, "review").scope, "project");
    assert.equal(JSON.parse(readFileSync(local, "utf8")).review, true);
    r = (await d.api("/api/settings", { changes: [{ id: "lsp", value: true }], scope: "user" })).json;
    assert.equal(item(r.settings, "lsp").scope, "user"); assert.equal(JSON.parse(readFileSync(user, "utf8")).lsp, true);
    r = (await d.api("/api/settings", { changes: [{ id: "plans", value: true }], scope: "chat" })).json;
    assert.equal(item(r.settings, "plans").scope, "chat"); assert.equal(JSON.parse(readFileSync(local, "utf8")).plans, undefined); assert.equal(JSON.parse(readFileSync(user, "utf8")).plans, undefined);
  } finally { await d.close(); }
});

test("desktop start: the window shows its own start screen at once (a local page with its own strict policy) and the app page fades the same picture out", () => {
  const ui = (f: string) => readFileSync(new URL(`../cli/desktop/ui/${f}`, import.meta.url), "utf8"), main = readFileSync(new URL("../cli/desktop/electron-main.cjs", import.meta.url), "utf8");
  assert.match(ui("splash.html"), /http-equiv="Content-Security-Policy" content="default-src 'none'/); assert.match(ui("splash.html"), />A<\/span>/);
  assert.match(main, /AMNESS_DESKTOP_WAIT/); assert.match(main, /loadFile\(path\.join\(__dirname, "ui", "splash\.html"\)\)/);
  assert.match(ui("index.html"), /id="boot"/); assert.match(ui("app.js"), /bootDone\(\)/);
});

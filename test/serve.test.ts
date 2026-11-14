import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "../src/index.ts";
import { call, say, sleep } from "./helpers/apprig.ts";

process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-serve-home-"));
const { startDesktopServer, hostsFor } = await import("../cli/desktop/server.ts");
const { ApiSessions } = await import("../cli/serve/sessions.ts");
const { v1Routes } = await import("../cli/serve/api.ts");
const { serveToken } = await import("../cli/serve.ts");

async function boot(replies: Message[], o: { roots?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "amness-serve-")); writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(process.env.AMNESS_HOME!, "state.json"), JSON.stringify({ verifyByDir: {}, tasks: [], trustedDirs: [dir] }));
  const queue = [...replies]; const model: Model = async (_m, _s, op) => { const r = queue.shift() ?? say("(done)"); if (r.content && op?.onText) op.onText(r.content); return r; };
  const cfg = { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "test-model", maxTokens: 100000 } as any;
  const sessions = new ApiSessions({ cfg, version: "0.0.0", roots: o.roots ?? [dir], defaultCwd: dir, persist: false, makeModel: () => model });
  const v1 = v1Routes(sessions, { version: "0.0.0" });
  const srv = await startDesktopServer({ cfg, cwd: dir, version: "0.0.0", persist: false, makeModel: () => model, net: { token: "test-token-0123456789abcdef", extra: v1.handler } });
  const base = `http://127.0.0.1:${srv.port}`;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer test-token-0123456789abcdef" }) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, json: j };
  };
  const events: any[] = [], ctrl = new AbortController();
  const es = await fetch(`${base}/v1/events?t=test-token-0123456789abcdef`, { signal: ctrl.signal });
  void (async () => { const rd = es.body!.getReader(), dec = new TextDecoder(); let buf = ""; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const d = chunk.split("\n").find((l) => l.startsWith("data: ")); if (d) events.push(JSON.parse(d.slice(6))); } } } catch { /* closed */ } })();
  const until = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
  return { dir, base, api, events, until, sessions, close: async () => { ctrl.abort(); v1.close(); sessions.closeAll(); await srv.close(); } };
}

test("serve API: health and the OpenAPI document are open; everything else needs the token; foreign hosts and origins are refused", async () => {
  const d = await boot([]);
  try {
    assert.equal((await d.api("GET", "/v1/health", undefined, {})).json.ok, true);
    const spec = (await d.api("GET", "/v1/openapi.json", undefined, {})).json; assert.equal(spec.openapi, "3.1.0"); assert.ok(spec.paths["/v1/sessions/{id}/messages"]);
    assert.equal((await d.api("GET", "/v1/sessions", undefined, {})).status, 401);
    assert.equal((await d.api("GET", "/v1/sessions", undefined, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await d.api("GET", "/v1/sessions", undefined, { "x-amness-token": "test-token-0123456789abcdef" })).status, 200);
    assert.equal((await d.api("GET", "/v1/sessions", undefined, { authorization: "Bearer test-token-0123456789abcdef", origin: "https://evil.example" })).status, 403);
    const port = new URL(d.base).port;
    const rebind = await new Promise<number>((ok) => { const r = request({ host: "127.0.0.1", port, path: "/v1/health", headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); ok(res.statusCode!); }); r.end(); });
    assert.equal(rebind, 403, "a DNS-rebinding Host is refused");
  } finally { await d.close(); }
});

test("serve API: a session runs a turn, waits for an approval the client answers, streams items and finishes; commands and folder limits", async () => {
  const d = await boot([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "two", new: "2" }), say("changed two to 2")]);
  try {
    assert.equal((await d.api("POST", "/v1/sessions", { cwd: "/" })).status, 403, "a folder outside --root is refused");
    const s = (await d.api("POST", "/v1/sessions", { title: "api test" })).json; assert.equal(s.status, "idle"); assert.equal(s.model, "test-model"); assert.equal(s.title, "api test");
    const r1 = (await d.api("POST", `/v1/sessions/${s.id}/messages`, { text: "change two to 2", wait: true, timeoutMs: 5000 })).json;
    assert.equal(r1.session.status, "waiting"); const dlg = r1.session.dialog; assert.equal(dlg.kind, "choice"); assert.ok(dlg.options.some((o: any) => /yes/i.test(o.label)));
    assert.ok(d.events.some((e) => e.type === "dialog" && e.session === s.id));
    assert.equal((await d.api("POST", `/v1/sessions/${s.id}/dialog`, { id: dlg.id + 99, value: 0 })).status, 409);
    assert.equal((await d.api("POST", `/v1/sessions/${s.id}/dialog`, { id: dlg.id, value: 0 })).status, 200);
    assert.ok(await d.until(() => d.events.some((e) => e.type === "turn.completed" && e.session === s.id)), JSON.stringify(d.events.map((e) => e.type)));
    assert.equal(readFileSync(join(d.dir, "a.txt"), "utf8"), "one\n2\n");
    const v = (await d.api("GET", `/v1/sessions/${s.id}`)).json; assert.equal(v.status, "idle"); assert.equal(v.lastAnswer, "changed two to 2"); assert.equal(v.turns, 1);
    const items = (await d.api("GET", `/v1/sessions/${s.id}/items`)).json.items; assert.deepEqual(items.filter((b: any) => b.kind !== "notice" && b.kind !== "raw").map((b: any) => b.kind), ["user", "tool", "tool", "assistant"]);
    assert.ok(items.find((b: any) => b.kind === "tool" && b.name === "edit_file").edit);
    assert.ok(d.events.some((e) => e.type === "item" && e.item.kind === "assistant"));
    const st = (await d.api("POST", `/v1/sessions/${s.id}/commands`, { command: "/status" })).json; assert.ok(st.lines.some((l: string) => /test-model/.test(l)));
    assert.equal((await d.api("POST", `/v1/sessions/${s.id}/commands`, { command: "rm -rf" })).status, 400);
    assert.equal((await d.api("POST", `/v1/sessions/${s.id}/mode`, { mode: "plan" })).json.mode, "plan");
    assert.equal((await d.api("POST", `/v1/sessions/${s.id}/mode`, { mode: "root" })).status, 400);
    const list = (await d.api("GET", "/v1/sessions")).json; assert.deepEqual(list.open.map((x: any) => x.id), [s.id]);
    assert.equal((await d.api("DELETE", `/v1/sessions/${s.id}`)).status, 200);
    assert.equal((await d.api("GET", `/v1/sessions/${s.id}`)).status, 404);
  } finally { await d.close(); }
});

test("serve: the token is saved owner-only and kept; --rotate makes a new one; a network bind answers to this machine's names, not others", () => {
  delete process.env.AMNESS_SERVE_TOKEN;
  const a = serveToken(), b = serveToken(); assert.equal(a, b); assert.ok(a.length >= 40);
  if (process.platform !== "win32") assert.equal(statSync(join(process.env.AMNESS_HOME!, "serve.json")).mode & 0o777, 0o600);
  assert.notEqual(serveToken(true), a);
  const local = hostsFor("127.0.0.1", 4747); assert.ok(local.has("127.0.0.1:4747") && local.has("localhost:4747")); assert.ok(![...local].some((h) => h.startsWith("192.168.")));
  const lan = hostsFor("0.0.0.0", 4747, ["amness.home.example"]); assert.ok(lan.has("amness.home.example") && lan.has("amness.home.example:4747")); assert.ok(!lan.has("evil.example:4747"));
});

test("AmnessClient.run: opens a session, answers the approval, returns the answer, closes the session", async () => {
  const { AmnessClient } = await import("../src/index.ts");
  const d = await boot([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "one", new: "1" }), say("done: one is 1")]);
  try {
    const c = new AmnessClient({ url: d.base, token: "test-token-0123456789abcdef" });
    assert.equal((await c.health()).ok, true);
    const asked: string[] = [];
    const r = await c.run("change one to 1", { onDialog: (dl) => { asked.push(dl.kind); return 0; }, timeoutMs: 10_000 });
    assert.equal(r.finished, true); assert.equal(r.text, "done: one is 1"); assert.deepEqual(asked, ["choice"]);
    assert.equal(readFileSync(join(d.dir, "a.txt"), "utf8"), "1\ntwo\n");
    assert.deepEqual((await c.sessions()).open, []);
    await assert.rejects(new AmnessClient({ url: d.base, token: "nope-nope-nope-nope-nope" }).sessions(), /401/);
  } finally { await d.close(); }
});

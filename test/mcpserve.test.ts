import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Message, Model } from "../src/index.ts";
import { call, say } from "./helpers/apprig.ts";

process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-mcpserve-home-"));
const { ApiSessions } = await import("../cli/serve/sessions.ts");
const { serveMcpStdio, mcpHttpRoute } = await import("../cli/mcpserve.ts");
const { startDesktopServer } = await import("../cli/desktop/server.ts");
const { connectMcp } = await import("../src/index.ts");

function setup(replies: Message[]) {
  const dir = mkdtempSync(join(tmpdir(), "amness-mcpserve-")); writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(process.env.AMNESS_HOME!, "state.json"), JSON.stringify({ verifyByDir: {}, tasks: [], trustedDirs: [dir] }));
  const q = [...replies], model: Model = async (_m, _s, op) => { const r = q.shift() ?? say("(done)"); if (r.content && op?.onText) op.onText(r.content); return r; };
  const cfg = { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "test-model", maxTokens: 100000 } as any;
  return { dir, cfg, model, sessions: new ApiSessions({ cfg, version: "0", roots: [dir], defaultCwd: dir, persist: false, makeModel: () => model }) };
}
const editTask = () => [call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "two", new: "2" }), say("two is now 2")];

test("amness mcp serve over stdio (initialize-era client): amness_run, the approval goes to the client's user as elicitation/create, the answer comes back", async () => {
  const s = setup(editTask()), input = new PassThrough(), output = new PassThrough(), lines: any[] = []; let buf = "";
  output.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(m); if (m.method === "elicitation/create") input.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { action: "accept", content: { choice: m.params.requestedSchema.properties.choice.enum[0] } } }) + "\n"); } });
  const done = serveMcpStdio(s.sessions, { version: "9", input, output });
  const send = (m: any) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const until = async (f: () => boolean) => { for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f(), JSON.stringify(lines).slice(0, 2000)); };
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "x" } } });
  await until(() => lines.some((l) => l.id === 1)); assert.equal(lines.find((l) => l.id === 1).result.protocolVersion, "2025-06-18");
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" }); await until(() => lines.some((l) => l.id === 2));
  assert.deepEqual(lines.find((l) => l.id === 2).result.tools.map((t: any) => t.name), ["amness_run", "amness_status", "amness_reply", "amness_answer", "amness_sessions", "amness_close"]);
  send({ id: 3, method: "tools/call", params: { name: "amness_run", arguments: { task: "change two to 2", wait_seconds: 20 } } });
  await until(() => lines.some((l) => l.id === 3));
  const r = lines.find((l) => l.id === 3).result;
  assert.ok(lines.some((l) => l.method === "elicitation/create" && /Amness \(.+\) asks/.test(l.params.message)), "the approval was asked through the client");
  assert.equal(r.structuredContent.status, "idle"); assert.equal(r.structuredContent.answer, "two is now 2"); assert.match(r.content[0].text, /two is now 2/);
  assert.equal(readFileSync(join(s.dir, "a.txt"), "utf8"), "one\n2\n");
  input.end(); await done; s.sessions.closeAll();
});

test("amness serve's /mcp (2026-07-28 over HTTP, token required): Amness's own MCP client runs a task and answers the approval through MRTR", async () => {
  const s = setup(editTask()), route = mcpHttpRoute(s.sessions, { version: "9" });
  const srv = await startDesktopServer({ cfg: s.cfg, cwd: s.dir, version: "0", persist: false, makeModel: () => s.model, net: { token: "tok-0123456789abcdef0123", extra: async (req, res, u, authed) => { if (u.pathname !== "/mcp") return false; await route(req, res, authed); return true; } } });
  try {
    const url = `http://127.0.0.1:${srv.port}/mcp`;
    await assert.rejects(connectMcp({ type: "http", url }, { name: "a", probeMs: 3000 }), /sign-in|401/);
    const asked: string[] = [];
    const h = await connectMcp({ type: "http", url, headers: { Authorization: "Bearer tok-0123456789abcdef0123" } }, { name: "amness", elicit: async (q) => { asked.push(q.message); return { action: "accept", content: { choice: (q.schema!.properties!.choice.enum as string[])[0] } }; } });
    assert.equal(h.era, "modern"); assert.equal(h.server.name, "amness");
    const out = String(await h.tools.find((t) => t.name === "amness__amness_run")!.run({ task: "change two to 2", wait_seconds: 20 }, {} as any));
    assert.match(out, /idle/); assert.match(out, /two is now 2/); assert.equal(asked.length, 1);
    assert.equal(readFileSync(join(s.dir, "a.txt"), "utf8"), "one\n2\n");
    assert.match(String(await h.tools.find((t) => t.name === "amness__amness_sessions")!.run({}, {} as any)), /idle/);
    h.close();
  } finally { s.sessions.closeAll(); await srv.close(); }
});

test("a client that cannot ask its user: the caller's agent sees the numbered question and answers with amness_answer", async () => {
  const s = setup(editTask()), route = mcpHttpRoute(s.sessions, { version: "9" });
  const srv = await startDesktopServer({ cfg: s.cfg, cwd: s.dir, version: "0", persist: false, makeModel: () => s.model, net: { token: "tok-0123456789abcdef0123", extra: async (req, res, u, authed) => { if (u.pathname !== "/mcp") return false; await route(req, res, authed); return true; } } });
  try {
    const h = await connectMcp({ type: "http", url: `http://127.0.0.1:${srv.port}/mcp`, headers: { Authorization: "Bearer tok-0123456789abcdef0123" } }, { name: "amness" });
    const t = (n: string) => h.tools.find((x) => x.name === `amness__${n}`)!;
    const first = String(await t("amness_run").run({ task: "change two to 2", wait_seconds: 20 }, {} as any));
    const m = /session (\S+) · waiting[\s\S]*dialog (\d+)\)[\s\S]*1\. (.*Yes.*)/.exec(first); assert.ok(m, first);
    const done = String(await t("amness_answer").run({ session: m[1], dialog: Number(m[2]), choice: "1", wait_seconds: 20 }, {} as any));
    assert.match(done, /idle[\s\S]*two is now 2/); assert.equal(readFileSync(join(s.dir, "a.txt"), "utf8"), "one\n2\n");
    await assert.rejects(Promise.resolve(t("amness_answer").run({ session: m[1], dialog: 99, choice: "1" }, {} as any)), /not open/);
    assert.match(String(await t("amness_close").run({ session: m[1] }, {} as any)), /closed/);
    h.close();
  } finally { s.sessions.closeAll(); await srv.close(); }
});

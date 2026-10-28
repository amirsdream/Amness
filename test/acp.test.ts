import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createCodeAgent, serveAcp, type Message, type Model } from "../src/index.ts";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function rig(replies: Message[]) {
  const input = new PassThrough(), output = new PassThrough(), lines: any[] = []; let buf = "";
  output.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const q = [...replies], model: Model = (async (_m: Message[], _t: any, opts: any) => { const r = q.shift() ?? { role: "assistant", content: "(done)" }; if (r.content && opts?.onText) opts.onText(r.content); return r as Message; }) as Model;
  const dir = mkdtempSync(join(tmpdir(), "amness-acp-")); writeFileSync(join(dir, "a.txt"), "one\n");
  const done = serveAcp({ input, output, version: "9.9.9", makeAgent: ({ cwd, onEvent, approve, signal }) => createCodeAgent({ model, cwd, chat: true, approve, onEvent, signal, memory: false, permissions: { mode: () => "default" } }) });
  const send = (m: any) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const until = async (p: () => boolean) => { for (let i = 0; i < 400 && !p(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(p(), "timed out; got " + JSON.stringify(lines).slice(0, 600)); };
  return { dir, lines, send, until, done, input };
}
const tc = (name: string, args: any, id = "c1"): Message => ({ role: "assistant", content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

test("initialize, new session, a prompt that streams text and a tool call, then end_turn", async () => {
  const t = rig([tc("read_file", { path: "a.txt" }), { role: "assistant", content: "It says one." }]);
  t.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } }); await t.until(() => t.lines.some((l) => l.id === 0));
  assert.equal(t.lines.find((l) => l.id === 0).result.agentInfo.version, "9.9.9"); assert.equal(t.lines.find((l) => l.id === 0).result.protocolVersion, 1);
  t.send({ id: 1, method: "session/new", params: { cwd: t.dir, mcpServers: [] } }); await t.until(() => t.lines.some((l) => l.id === 1));
  const sessionId = t.lines.find((l) => l.id === 1).result.sessionId;
  t.send({ id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "what is in a.txt?" }] } }); await t.until(() => t.lines.some((l) => l.id === 2));
  assert.equal(t.lines.find((l) => l.id === 2).result.stopReason, "end_turn");
  const ups = t.lines.filter((l) => l.method === "session/update").map((l) => l.params.update);
  assert.ok(ups.some((u) => u.sessionUpdate === "tool_call" && u.kind === "read")); assert.ok(ups.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
  assert.ok(ups.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("It says one")));
  t.input.end(); await t.done;
});

test("a risky edit asks the editor for permission; rejecting leaves the file alone, allowing applies it", async () => {
  for (const choice of ["reject", "allow"]) {
    const t = rig([tc("read_file", { path: "a.txt" }, "r"), tc("write_file", { path: "a.txt", content: "two\n" }, "w"), { role: "assistant", content: "ok" }]);
    t.send({ id: 1, method: "session/new", params: { cwd: t.dir } }); await t.until(() => t.lines.some((l) => l.id === 1));
    const sessionId = t.lines.find((l) => l.id === 1).result.sessionId;
    t.send({ id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "change it" }] } });
    await t.until(() => t.lines.some((l) => l.method === "session/request_permission"));
    const req = t.lines.find((l) => l.method === "session/request_permission"); assert.ok(req.params.options.some((o: any) => o.kind === "allow_once"));
    t.send({ id: req.id, result: { outcome: { outcome: "selected", optionId: choice } } });
    await t.until(() => t.lines.some((l) => l.id === 2));
    assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), choice === "allow" ? "two\n" : "one\n");
    t.input.end(); await t.done;
  }
});

test("session/cancel stops the turn with stopReason cancelled; unknown methods and sessions are errors", async () => {
  let release!: () => void; const hold = new Promise<void>((r) => (release = r));
  const input = new PassThrough(), output = new PassThrough(), lines: any[] = []; let buf = "";
  output.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const done = serveAcp({ input, output, version: "1", makeAgent: ({ signal }) => ({ chat: async (h) => { await hold; return { messages: h, text: "", finished: false, stopped: signal()?.aborted ? "aborted" : undefined }; } }) });
  const send = (m: any) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"), until = async (p: () => boolean) => { for (let i = 0; i < 300 && !p(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(p()); };
  send({ id: 1, method: "session/new", params: { cwd: "." } }); await until(() => lines.some((l) => l.id === 1)); const sessionId = lines.find((l) => l.id === 1).result.sessionId;
  send({ id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "x" }] } }); await new Promise((r) => setTimeout(r, 30));
  send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [] } }); await until(() => lines.some((l) => l.id === 3)); assert.ok(lines.find((l) => l.id === 3).error);
  send({ method: "session/cancel", params: { sessionId } }); await new Promise((r) => setTimeout(r, 30)); release(); await until(() => lines.some((l) => l.id === 2));
  assert.equal(lines.find((l) => l.id === 2).result.stopReason, "cancelled");
  send({ id: 4, method: "nope" }); await until(() => lines.some((l) => l.id === 4)); assert.equal(lines.find((l) => l.id === 4).error.code, -32601);
  send({ id: 5, method: "session/prompt", params: { sessionId: "zzz", prompt: [] } }); await until(() => lines.some((l) => l.id === 5)); assert.ok(lines.find((l) => l.id === 5).error);
  input.end(); await done;
});

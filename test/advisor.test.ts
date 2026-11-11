import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, advisorCalls, anthropic, createCodeAgent, createHarness, defineTool, withCard, type Message, type Model } from "../src/index.ts";
import { nativeAdvisor } from "../cli/model.ts";

const fakeClient = (...replies: any[]) => {
  const reqs: any[] = [];
  const mk = (via: string) => ({ stream: (req: any) => (reqs.push({ via, ...structuredClone(req) }), { finalMessage: async () => replies.shift() }) });
  return { client: { messages: mk("plain"), beta: { messages: mk("beta") } }, reqs };
};
const usage = (extra: object = {}) => ({ input_tokens: 10, output_tokens: 5, ...extra });
const ADV = { type: "advisor_tool_result", tool_use_id: "srv1", content: { type: "advisor_redacted_result", encrypted_content: "xyz", stop_reason: "end_turn" } };
const SRV = { type: "server_tool_use", id: "srv1", name: "advisor", input: {} };

test("native advisor: the tool entry and the beta header are sent; pause_turn resumes with the same tools; advisor tokens are charged to the advisor", async () => {
  const f = fakeClient(
    { content: [{ type: "text", text: "Let me ask." }, SRV], stop_reason: "pause_turn", usage: usage({ iterations: [{ type: "message", input_tokens: 10, output_tokens: 5 }] }) },
    { content: [ADV, { type: "text", text: "Done." }], stop_reason: "end_turn", usage: usage({ iterations: [{ type: "advisor_message", model: "claude-opus-5-5", input_tokens: 900, output_tokens: 400 }] }) },
  );
  const m = anthropic({ model: "claude-haiku-5-5", client: f.client, fallbacks: false, advisor: { model: "claude-opus-5-5", maxUses: 3, maxTokens: 2048, caching: "5m" } });
  const r = await m([{ role: "user", content: "fix it" }], [{ name: "read", description: "", parameters: { type: "object" } }]);
  assert.equal(f.reqs.length, 2);
  for (const q of f.reqs) {
    assert.equal(q.via, "beta"); assert.ok(q.betas.includes("advisor-tool-2026-03-01"));
    assert.deepEqual(q.tools.at(-1), { type: "advisor_20260301", name: "advisor", model: "claude-opus-5-5", max_uses: 3, max_tokens: 2048, caching: { type: "ephemeral", ttl: "5m" } });
  }
  assert.deepEqual(JSON.stringify(f.reqs[0].tools), JSON.stringify(f.reqs[1].tools), "the tools are byte-identical across the resume");
  assert.deepEqual(f.reqs[1].messages.at(-1), { role: "assistant", content: [{ type: "text", text: "Let me ask." }, SRV] });
  assert.equal(r.content, "Let me ask.Done."); assert.deepEqual((r.raw as any[]).map((b) => b.type), ["text", "server_tool_use", "advisor_tool_result", "text"]);
  const b = new Budget(); b.add(r, { id: "claude-haiku-5-5", tier: "mid" });
  assert.equal(b.byModel["claude-opus-5-5"].tokens, 1300); assert.equal(b.byModel["claude-haiku-5-5"].tokens, 30);
  assert.equal(b.tokens, 1330);
});

test("native advisor: the conversation cap adds one note at a fixed place in history and never changes the tools", async () => {
  const f = fakeClient({ content: [{ type: "text", text: "a" }], stop_reason: "end_turn", usage: usage() }, { content: [{ type: "text", text: "b" }], stop_reason: "end_turn", usage: usage() });
  const m = anthropic({ model: "claude-haiku-5-5", client: f.client, fallbacks: false, advisor: { model: "claude-opus-5-5", cap: 2 } });
  const hist: Message[] = [{ role: "user", content: "go" }, { role: "assistant", content: null, raw: [SRV, ADV, { ...SRV, id: "s2" }, { ...ADV, tool_use_id: "s2" }, { type: "tool_use", id: "t1", name: "read", input: {} }] }, { role: "tool", tool_call_id: "t1", content: "text" }];
  assert.equal(advisorCalls(hist), 2);
  const spec = [{ name: "read", description: "", parameters: { type: "object" as const } }];
  await m(hist, spec); await m([...hist, { role: "assistant", content: "next" }, { role: "user", content: "more" }], spec);
  const notes = f.reqs.map((q) => JSON.stringify(q.messages[2]));
  assert.match(notes[0], /consulted 2 times/); assert.equal(notes[0], notes[1], "the note renders the same on every later request");
  assert.equal(JSON.stringify(f.reqs[0].tools), JSON.stringify(f.reqs[1].tools));
});

test("nativeAdvisor: only a Claude main model with a Claude advisor", () => {
  const c = (o: object) => ({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-5-5", maxTokens: 1, ...o }) as any;
  assert.equal(nativeAdvisor(c({ models: { advisor: "anthropic:claude-opus-5-5" } }))?.model, "claude-opus-5-5");
  assert.equal(nativeAdvisor(c({ models: { advisor: "claude-opus-5-5" } }))?.maxTokens, 2048);
  assert.equal(nativeAdvisor(c({ models: { advisor: "server:lab" } })), undefined);
  assert.equal(nativeAdvisor(c({ provider: "custom", models: { advisor: "anthropic:claude-opus-5-5" } })), undefined);
});

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `v${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const repo = () => { const d = mkdtempSync(join(tmpdir(), "amness-adv-")); writeFileSync(join(d, "a.txt"), "one\n"); return d; };

test("generic advisor: consulted before the first change and before finishing, once each, with a packet under its cap; the executor sees the advice", async () => {
  const d = repo(), packets: string[] = [];
  const adv: Model = withCard(async (m) => (packets.push(m[1].content ?? ""), { role: "assistant", content: packets.length === 1 ? "Edit a.txt line 1, then check it." : "OK" }), { id: "opus", tier: "frontier" });
  const lead = [call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "one", new: "two" }), call("edit_file", { path: "a.txt", old: "one", new: "two" }), call("finish", { summary: "changed" })];
  const seen: Message[][] = [];
  const main: Model = async (msgs) => (seen.push(msgs), lead.shift() ?? { role: "assistant", content: "done" });
  const r = await createCodeAgent({ model: main, advisor: adv, cwd: d, memory: false, guidance: false, index: false, permissions: { mode: () => "yolo" } }).run("change one to two in a.txt");
  assert.equal(r.finished, true);
  assert.equal(packets.length, 2, "start and finish, once each");
  assert.match(packets[0], /WHY YOU ARE ASKED: the engineer is about to make the first change/); assert.match(packets[0], /TASK:\nchange one to two/);
  assert.ok(packets.every((p) => p.length <= 20_000));
  const tools = seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);
  assert.match(tools[1], /^PAUSED before your first change[\s\S]*Edit a\.txt line 1/);
  assert.ok(seen[0].some((m) => m.role === "system" && /advise\(\{question\}\)/.test(m.content ?? "")));
});

test("generic advisor: a failing advisor never fails the run; the advise tool is capped per request", async () => {
  const d = repo();
  const broken: Model = async () => { throw new Error("HTTP 503"); };
  const lead = [call("edit_file", { path: "a.txt", old: "one", new: "two" }), call("finish", { summary: "ok" })];
  const r = await createCodeAgent({ model: async () => lead.shift()!, advisor: broken, cwd: d, memory: false, guidance: false, index: false, permissions: { mode: () => "yolo" } }).run("x");
  assert.equal(r.finished, true);
  let asked = 0;
  const adv: Model = async () => (asked++, { role: "assistant", content: "think harder" });
  const lead2 = [call("advise", { question: "a" }), call("advise", { question: "b" }), call("advise", { question: "c" }), call("finish", { summary: "ok" })];
  const r2 = await createCodeAgent({ model: async () => lead2.shift()!, advisor: adv, advisorCap: 2, cwd: d, memory: false, guidance: false, index: false, permissions: { mode: () => "yolo" } }).run("x");
  const outs = r2.messages.filter((m) => m.role === "tool").map((m) => m.content!);
  assert.equal(outs[0], "think harder"); assert.match(outs[2], /already asked 2 times/);
});

test("the stuck reflection carries the advisor's advice", async () => {
  const bad = defineTool({ name: "boom", description: "", schema: { type: "object" }, run: () => { throw new Error("nope"); } });
  const lead = [call("boom", {}), call("boom", {}), call("boom", {}), call("finish", { summary: "gave up" })];
  const seen: Message[][] = [];
  await createHarness({ model: async (m) => (seen.push(m), lead.shift()!), tools: [bad], off: ["loop"], advise: async (why) => (why === "stuck" ? "Stop calling boom; read the error." : undefined) }).run("go");
  assert.ok(seen.at(-1)!.some((m) => m.role === "user" && /Stop calling boom; read the error\.[\s\S]*Your last 3 turns all failed/.test(m.content ?? "")));
});

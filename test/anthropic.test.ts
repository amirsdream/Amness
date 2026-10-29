import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropic, createHarness, defineTool, fromAnthropic, toAnthropic, type Message } from "../src/index.ts";

const tu = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const resp = (content: any[], extra: object = {}) => ({ content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, ...extra });

/** Fake SDK client recording every request; replies from a queue. */
const fakeClient = (...replies: any[]) => {
  const reqs: { via: "beta" | "plain"; req: any }[] = [];
  const mk = (via: "beta" | "plain") => ({ stream: (req: any) => (reqs.push({ via, req: structuredClone(req) }), { finalMessage: async () => replies.shift() }) });
  return { client: { messages: mk("plain"), beta: { messages: mk("beta") } }, reqs };
};

test("toAnthropic: system hoisted, parallel tool results merged into one user message, errors flagged", () => {
  const msgs: Message[] = [
    { role: "system", content: "sys" }, { role: "user", content: "go" },
    { role: "assistant", content: "ok", tool_calls: [
      { id: "a", function: { name: "x", arguments: '{"n":1}' } }, { id: "b", function: { name: "y", arguments: "{bad" } }] },
    { role: "tool", tool_call_id: "a", content: "fine" }, { role: "tool", tool_call_id: "b", content: "ERROR: nope" },
    { role: "assistant", content: "" },
  ];
  const { system, messages } = toAnthropic(msgs);
  assert.equal(system, "sys"); assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(messages[1].content.map((b: any) => b.type), ["text", "tool_use", "tool_use"]);
  assert.deepEqual(messages[1].content[1].input, { n: 1 }); assert.deepEqual(messages[1].content[2].input, {}); // bad JSON -> {}
  assert.equal(messages[2].content.length, 2); assert.equal(messages[2].content[0].is_error, undefined); assert.equal(messages[2].content[1].is_error, true);
  assert.deepEqual(messages[3].content, [{ type: "text", text: "(no output)" }]);          // empty assistant turn stays valid
});

test("toAnthropic prefers raw blocks (thinking survives); a following user nudge merges after tool results", () => {
  const think = { type: "thinking", thinking: "", signature: "sig" };
  const { messages } = toAnthropic([
    { role: "user", content: "t" }, { role: "assistant", content: null, raw: [think, tu("a", "x", {})], tool_calls: [{ id: "a", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "r" }, { role: "user", content: "nudge" },
  ]);
  assert.deepEqual(messages[1].content[0], think);
  assert.deepEqual(messages[2].content.map((b: any) => b.type), ["tool_result", "text"]);
});

test("fromAnthropic: tool calls, usage incl. cache reads, refusal, and truncated tool calls never run", () => {
  const m = fromAnthropic(resp([{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "hi" }, tu("t1", "sh", { cmd: "ls" })]));
  assert.equal(m.tool_calls![0].function.arguments, '{"cmd":"ls"}'); assert.equal(m.usage!.total_tokens, 115); assert.equal((m.raw as any[]).length, 3);
  const ref = fromAnthropic({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" }, usage: {} });
  assert.match(ref.content!, /declined: cyber/); assert.equal(ref.tool_calls, undefined);
  const cut = fromAnthropic(resp([{ type: "text", text: "writing" }, tu("t2", "write_file", { path: "a" })], { stop_reason: "max_tokens" }));
  assert.equal(cut.tool_calls, undefined); assert.ok(!(cut.raw as any[]).some((b) => b.type === "tool_use")); assert.match(cut.content!, /I'll redo/);
});

test("request shape: Opus 5.5 = adaptive thinking + effort + auto-cache + server-side fallbacks via beta; Haiku 4.5 = plain", async () => {
  let f = fakeClient(resp([{ type: "text", text: "a" }]));
  const tools = [{ name: "t", description: "d", parameters: { type: "object" as const, properties: { a: { type: "string" as const } } } }];
  await anthropic({ client: f.client })([{ role: "system", content: "S" }, { role: "user", content: "U" }], tools);
  const { via, req } = f.reqs[0];
  assert.equal(via, "beta"); assert.equal(req.model, "claude-opus-5-5"); assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]); assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.thinking, { type: "adaptive" }); assert.deepEqual(req.output_config, { effort: "high" }); assert.deepEqual(req.cache_control, { type: "ephemeral" });
  assert.equal(req.system, "S"); assert.deepEqual(req.tools[0].input_schema.properties, { a: { type: "string" } }); assert.equal(req.tool_choice, undefined);
  f = fakeClient(resp([{ type: "text", text: "a" }]));
  await anthropic({ client: f.client, model: "claude-haiku-4-5", effort: "low" })([{ role: "user", content: "U" }], []);
  assert.equal(f.reqs[0].via, "plain"); assert.equal(f.reqs[0].req.thinking, undefined); assert.equal(f.reqs[0].req.fallbacks, undefined); assert.equal(f.reqs[0].req.tools, undefined);
  f = fakeClient(resp([{ type: "text", text: "a" }]));
  await anthropic({ client: f.client, model: "claude-haiku-5-5", effort: "low" })([{ role: "user", content: "U" }], []);
  assert.deepEqual(f.reqs[0].req.output_config, { effort: "low" }); assert.equal(f.reqs[0].via, "plain"); // Haiku 5.5: thinking yes, fallbacks no
});

test("through the harness: thinking blocks are replayed verbatim and history is never edited (appendOnly)", async () => {
  const think = { type: "thinking", thinking: "", signature: "SIG" };
  const big = defineTool({ name: "big", description: "", schema: { type: "object" }, run: () => "x".repeat(900) });
  const f = fakeClient(
    resp([think, tu("a", "big", { i: 1 })]), resp([tu("b", "big", { i: 2 })]), resp([tu("c", "big", { i: 3 })]),
    resp([tu("d", "finish", { summary: "done" })]));
  const model = anthropic({ client: f.client });
  assert.equal(model.appendOnly, true);
  const r = await createHarness({ model, tools: [big], contextBudget: 500 }).run("t");   // tiny budget would elide with a normal model
  assert.equal(r.text, "done"); assert.equal(r.tokens, 4 * 115);
  const last = f.reqs.at(-1)!.req.messages;
  assert.deepEqual(last[1].content[0], think);                                            // replayed byte-for-byte
  assert.ok(last.flatMap((m: any) => m.content).filter((b: any) => b.type === "tool_result").every((b: any) => b.content.length === 900)); // nothing elided
  // each request's messages extend the previous one: append-only => cache-friendly
  for (let i = 1; i < f.reqs.length; i++) assert.deepEqual(f.reqs[i].req.messages.slice(0, f.reqs[i - 1].req.messages.length), f.reqs[i - 1].req.messages);
});

test("missing SDK / credentials surface as clear errors, not silent failures", async () => {
  const f = fakeClient();
  f.client.beta.messages.stream = () => { throw new Error("401 authentication_error"); };
  await assert.rejects(anthropic({ client: f.client })([{ role: "user", content: "x" }], []), /authentication/);
});

test("taskBudget: sent as output_config.task_budget with the beta header on supported models only, and never below 20000", async () => {
  const ask = async (model: string, taskBudget?: number) => { const f = fakeClient(resp([{ type: "text", text: "a" }])); await anthropic({ client: f.client, model, taskBudget })([{ role: "user", content: "U" }], []); return f.reqs[0]; };
  const on = await ask("claude-sonnet-5-5", 64000);
  assert.equal(on.via, "beta"); assert.deepEqual(on.req.output_config.task_budget, { type: "tokens", total: 64000 }); assert.ok(on.req.betas.includes("task-budgets-2026-03-13"));
  assert.equal((await ask("claude-sonnet-5", 64000)).req.output_config?.task_budget, undefined);         // not supported on Sonnet 5
  assert.equal((await ask("claude-sonnet-5-5", 5000)).req.output_config?.task_budget, undefined);        // below the 20000 minimum: not sent
  assert.equal((await ask("claude-sonnet-5-5")).req.output_config?.task_budget, undefined);
});

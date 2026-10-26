import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHarness, defineTool, effortsFor, fromResponse, isOpenAIHost, isReasoningModel, openai, toResponsesInput, type Message } from "../src/index.ts";

const LUNA_ERROR = { error: { message: "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to none.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_parameter" } };

type Route = (body: any, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
async function server(routes: Record<string, Route | Route[]>) {
  const seen: { path: string; body: any }[] = [], counters: Record<string, number> = {};
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", async () => {
      const path = req.url!, body = b ? JSON.parse(b) : {};
      seen.push({ path, body });
      const r = routes[path]; const h = Array.isArray(r) ? r[Math.min(counters[path] = (counters[path] ?? -1) + 1, r.length - 1)] : r;
      if (!h) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "not found" } })); return; }
      await h(body, req, res);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, seen, paths: () => seen.map((s) => s.path.replace("/v1", "")), close: () => srv.closeAllConnections?.() ?? srv.close() };
}
const json = (status: number, obj: object): Route => (_b, _q, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const sse = (events: object[]): Route => async (_b, _q, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) { res.write(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`); await new Promise((r) => setTimeout(r, 1)); }
  res.end();
};
const usage = { input_tokens: 1200, output_tokens: 300, total_tokens: 1500, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 220 } };
const textResp = (text: string) => ({ id: "resp_1", status: "completed", output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage });
const callResp = (name: string, args: object, id = "call_1") => ({ id: "resp_2", status: "completed", usage, output: [
  { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "ENC-1" },
  { id: "fc_1", type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] });
const asEvents = (resp: any, deltas: string[] = []) => [
  { type: "response.created", response: { id: resp.id } },
  ...deltas.map((d) => ({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: d })),
  ...resp.output.map((item: any, i: number) => ({ type: "response.output_item.done", output_index: i, item })),
  { type: "response.completed", response: resp }];
const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object" as const, required: ["path"], properties: { path: { type: "string" as const } } } }];
const user = (content: string): Message => ({ role: "user", content });

test("helpers: reasoning-model detection, host detection, per-model effort sets", () => {
  for (const m of ["gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.5", "o3", "o4-mini"]) assert.ok(isReasoningModel(m), m);
  for (const m of ["gpt-4.1", "gpt-4o-mini", "llama3", "claude-opus-5-5"]) assert.ok(!isReasoningModel(m), m);
  assert.ok(isOpenAIHost("https://api.openai.com/v1") && !isOpenAIHost("http://localhost:11434/v1") && !isOpenAIHost("not a url"));
  assert.deepEqual(effortsFor("gpt-6.1-sol"), ["low", "medium", "high", "xhigh", "max"]);       // Astra/Sol reject `none`
  assert.ok(effortsFor("gpt-6-luna").includes("none") && effortsFor("gpt-5.6-luna").includes("none"));
  assert.deepEqual(effortsFor("gpt-4.1"), []);
});

test("toResponsesInput: instructions, user text, function_call/function_call_output pairs, and same-model replay of reasoning items", () => {
  const items = [{ id: "rs_1", type: "reasoning", summary: [], encrypted_content: "E" }, { id: "fc_1", type: "function_call", call_id: "call_9", name: "sh", arguments: "{}" }];
  const msgs: Message[] = [
    { role: "system", content: "Be brief." }, user("hi"),
    { role: "assistant", content: null, tool_calls: [{ id: "call_9", function: { name: "sh", arguments: "{}" } }], raw: { api: "responses", model: "gpt-6.1-sol", items } },
    { role: "tool", tool_call_id: "call_9", content: "ok" },
    { role: "assistant", content: "done", tool_calls: [{ id: "c2", function: { name: "read_file", arguments: '{"path":"a"}' } }] },     // no raw (older session / other provider)
    { role: "tool", tool_call_id: "c2", content: "text" },
  ];
  const r = toResponsesInput(msgs, "gpt-6.1-sol");
  assert.equal(r.instructions, "Be brief.");
  assert.deepEqual(r.input, [
    { role: "user", content: "hi" }, ...items, { type: "function_call_output", call_id: "call_9", output: "ok" },
    { role: "assistant", content: "done" }, { type: "function_call", call_id: "c2", name: "read_file", arguments: '{"path":"a"}' }, { type: "function_call_output", call_id: "c2", output: "text" }]);
  const other = toResponsesInput(msgs, "gpt-6-luna").input;                                     // different model: encrypted reasoning is NOT replayed, calls are rebuilt
  assert.ok(!other.some((i: any) => i.type === "reasoning") && other.some((i: any) => i.type === "function_call" && i.call_id === "call_9"));
  assert.ok(!toResponsesInput([{ role: "assistant", content: "x", raw: [{ type: "thinking" }] as any }], "m").input.some((i: any) => i.type === "thinking"));   // a Claude `raw` is ignored
});

test("fromResponse: text, refusal, function calls, usage incl. cached + reasoning tokens, truncated calls dropped", () => {
  const m = fromResponse(callResp("read_file", { path: "a.ts" }), "gpt-6.1-sol");
  assert.deepEqual(m.tool_calls, [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }]);
  assert.equal(m.content, null); assert.deepEqual((m.raw as any).items.map((i: any) => i.type), ["reasoning", "function_call"]);
  assert.deepEqual(m.usage, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cached_tokens: 1000, reasoning_tokens: 220 });
  assert.equal(fromResponse(textResp("hello"), "m").content, "hello");
  assert.match(fromResponse({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }, "m").content!, /\[declined\] no/);
  const cut = fromResponse({ ...callResp("read_file", {}), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "m");
  assert.equal(cut.tool_calls, undefined); assert.match(cut.content!, /I'll redo that in smaller steps/); assert.ok(!(cut.raw as any).items.some((i: any) => i.type === "reasoning" || i.type === "function_call"));
});

test("THE REPORTED BUG: gpt-5.6-luna on Chat Completions returns the 400; the adapter switches to /v1/responses by itself and remembers", async () => {
  const s = await server({ "/v1/chat/completions": json(400, LUNA_ERROR), "/v1/responses": [json(200, textResp("first")), json(200, textResp("second"))] });
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-5.6-luna", apiKey: "k" });
    assert.equal(m.api!(), "chat");                                                              // non-OpenAI host: starts on chat
    const r1 = await m([{ role: "system", content: "sys" }, user("hi")], tools);
    assert.equal(r1.content, "first"); assert.equal(m.api!(), "responses");
    await m([user("again")], tools);
    assert.deepEqual(s.paths(), ["/chat/completions", "/responses", "/responses"]);              // no second detour
    const b = s.seen[1].body;
    assert.equal(b.model, "gpt-5.6-luna"); assert.equal(b.instructions, "sys"); assert.deepEqual(b.input, [{ role: "user", content: "hi" }]);
    assert.deepEqual(b.tools, [{ type: "function", name: "read_file", description: "Read a file", parameters: tools[0].parameters, strict: false }]);   // flat shape, not {function:{...}}
    assert.equal(b.tool_choice, "auto"); assert.equal(b.store, false); assert.deepEqual(b.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(b.reasoning, { summary: "auto" });                                          // no effort unless asked: the model's default applies
    assert.equal(b.messages, undefined); assert.equal(b.stream, false);
  } finally { s.close(); }
});

test("streaming over Responses: text + reasoning-summary deltas are forwarded; tool calls and usage come from the completed response", async () => {
  const resp = callResp("read_file", { path: "src/a.ts" });
  const events = [
    { type: "response.created", response: { id: "r" } },
    { type: "response.reasoning_summary_text.delta", delta: "Checking the " }, { type: "response.reasoning_summary_text.delta", delta: "file first." },
    { type: "response.output_text.delta", delta: "Let me " }, { type: "response.output_text.delta", delta: "read it." },
    ...resp.output.map((item, i) => ({ type: "response.output_item.done", output_index: i, item })),
    { type: "response.completed", response: resp }];
  const s = await server({ "/v1/responses": sse(events) });
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-6.1-sol", api: "responses", effort: "high" });
    const text: string[] = [], think: string[] = [];
    const r = await m([user("go")], tools, { onText: (d) => text.push(d), onThinking: (d) => think.push(d) });
    assert.deepEqual(text, ["Let me ", "read it."]); assert.deepEqual(think, ["Checking the ", "file first."]);
    assert.equal(r.tool_calls![0].function.arguments, '{"path":"src/a.ts"}'); assert.equal(r.usage!.cached_tokens, 1000); assert.equal(r.usage!.reasoning_tokens, 220);
    assert.equal(s.seen[0].body.stream, true); assert.deepEqual(s.seen[0].body.reasoning, { effort: "high", summary: "auto" });
  } finally { s.close(); }
});

test("agent loop over Responses: reasoning + function_call items are replayed with the function_call_output, in order, with matching call_id", async () => {
  const s = await server({ "/v1/responses": [sse(asEvents(callResp("read_file", { path: "a" }, "call_77"))), sse(asEvents(textResp("All done."), ["All done."]))] });
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-6.1-sol", api: "responses" });
    const t = defineTool({ name: "read_file", description: "Read a file", schema: tools[0].parameters, run: () => "file contents" });
    const r = await createHarness({ model: m, tools: [t] }).run("read a");
    assert.equal(r.text, "All done.");
    const second = s.seen[1].body.input;
    assert.deepEqual(second.map((i: any) => i.type ?? i.role), ["user", "reasoning", "function_call", "function_call_output"]);
    assert.equal(second[1].encrypted_content, "ENC-1");                                          // the opaque reasoning blob survives the round trip
    assert.deepEqual(second[3], { type: "function_call_output", call_id: "call_77", output: "file contents" });
  } finally { s.close(); }
});

test("switching models mid-conversation does not replay another model's reasoning; chat requests never leak `raw`/`usage`", async () => {
  const s = await server({ "/v1/responses": sse(asEvents(textResp("ok"))), "/v1/chat/completions": json(200, { choices: [{ message: { role: "assistant", content: "chat ok" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }) });
  try {
    const history: Message[] = [user("hi"), { role: "assistant", content: null, usage: { total_tokens: 9 }, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }], raw: { api: "responses", model: "gpt-6.1-sol", items: [{ type: "reasoning", encrypted_content: "X" }, { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }] } },
      { role: "tool", tool_call_id: "c1", content: "r" }];
    await openai({ baseUrl: s.url, model: "gpt-6-luna", api: "responses" })(history, tools);
    assert.ok(!s.seen[0].body.input.some((i: any) => i.type === "reasoning"));
    const c = await openai({ baseUrl: s.url, model: "gpt-4.1", api: "chat" })(history, tools);
    const sent = s.seen[1].body;
    assert.ok(sent.messages.every((m: any) => !("raw" in m) && !("usage" in m))); assert.equal(sent.messages[1].tool_calls[0].type, "function");
    assert.equal(sent.reasoning_effort, undefined); assert.equal(sent.reasoning, undefined);       // non-reasoning model: never sent
    assert.equal(c.usage!.cached_tokens, 3);
  } finally { s.close(); }
});

test("options the account refuses are dropped, once, without losing the request: summaries (org not verified) and effort", async () => {
  const s = await server({ "/v1/responses": [
    json(400, { error: { message: "Your organization must be verified to generate reasoning summaries.", param: "reasoning.summary" } }),
    json(400, { error: { message: "Unsupported value: 'xhigh' is not supported with this model for reasoning.effort." } }),
    json(200, textResp("fine")), json(200, textResp("again"))] });
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-6.1-sol", api: "responses", effort: "xhigh" });
    assert.equal((await m([user("x")], [])).content, "fine");
    assert.deepEqual(s.seen.map((x) => x.body.reasoning), [{ effort: "xhigh", summary: "auto" }, { effort: "xhigh" }, undefined]);
    await m([user("y")], []); assert.equal(s.seen[3].body.reasoning, undefined);                  // remembered: no repeated 400s
  } finally { s.close(); }
});

test("a gateway without /v1/responses: after being told to use it, a 404 sends us back to chat with reasoning_effort none", async () => {
  const s = await server({ "/v1/chat/completions": [json(400, LUNA_ERROR), json(200, { choices: [{ message: { role: "assistant", content: "via chat" } }] })] });   // /v1/responses -> 404 by default
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-5.6-luna" });
    assert.equal((await m([user("hi")], tools)).content, "via chat");
    assert.deepEqual(s.paths(), ["/chat/completions", "/responses", "/chat/completions"]); assert.equal(s.seen[2].body.reasoning_effort, "none"); assert.equal(m.api!(), "chat");
  } finally { s.close(); }
});

test("api:'chat' is respected (never flips) but still applies the documented workaround; non-reasoning models stay on chat untouched", async () => {
  const s = await server({ "/v1/chat/completions": [json(400, LUNA_ERROR), json(200, { choices: [{ message: { role: "assistant", content: "ok" } }] }), json(200, { choices: [{ message: { role: "assistant", content: "ok" } }] })] });
  try {
    const forced = openai({ baseUrl: s.url, model: "gpt-5.6-luna", api: "chat" });
    assert.equal((await forced([user("hi")], tools)).content, "ok"); assert.deepEqual(s.paths(), ["/chat/completions", "/chat/completions"]); assert.equal(s.seen[1].body.reasoning_effort, "none");
    await openai({ baseUrl: s.url, model: "gpt-4.1" })([user("hi")], tools);
    assert.equal(s.seen[2].path, "/v1/chat/completions"); assert.equal(s.seen[2].body.reasoning_effort, undefined);
  } finally { s.close(); }
});

test("failures surface clearly: response.failed events, error events, truncated streams", async () => {
  const s = await server({ "/v1/responses": [
    sse([{ type: "response.failed", response: { error: { message: "The server had an error" } } }]),
    sse([{ type: "error", message: "rate limited upstream" }]), sse([{ type: "response.created", response: {} }]) ] });
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-6.1-sol", api: "responses" });
    await assert.rejects(m([user("x")], [], { onText: () => {} }), /response failed: The server had an error/);
    await assert.rejects(m([user("x")], [], { onText: () => {} }), /rate limited upstream/);
    await assert.rejects(m([user("x")], [], { onText: () => {} }), /ended before it completed/);
  } finally { s.close(); }
});

test("promptCacheKey is sent to OpenAI only; auth errors are not retried", async () => {
  const s = await server({ "/v1/responses": [json(401, { error: { message: "Incorrect API key" } })] });
  try {
    const t0 = Date.now();
    await assert.rejects(openai({ baseUrl: s.url, model: "gpt-6.1-sol", api: "responses", promptCacheKey: "proj-1" })([user("x")], []), /HTTP 401/);
    assert.equal(s.seen.length, 1); assert.ok(Date.now() - t0 < 1500); assert.equal(s.seen[0].body.prompt_cache_key, undefined);      // 127.0.0.1 is not api.openai.com
  } finally { s.close(); }
});

test("optional fields a server does not know (prompt_cache_key, include, stream_options) are dropped one by one, then remembered", async () => {
  const s = await server({
    "/v1/responses": [json(400, { error: { message: "Unknown parameter: 'include'." } }), json(200, textResp("ok")), json(200, textResp("ok2"))],
    "/v1/chat/completions": [json(400, { error: { message: "Unrecognized request argument supplied: stream_options" } }), json(200, { choices: [{ message: { role: "assistant", content: "chat ok" } }] })] });
  try {
    const m = openai({ baseUrl: s.url, model: "gpt-6.1-sol", api: "responses" });
    assert.equal((await m([user("a")], [])).content, "ok");
    assert.ok("include" in s.seen[0].body && !("include" in s.seen[1].body));
    await m([user("b")], []); assert.ok(!("include" in s.seen[2].body));                          // not re-sent
    const c = openai({ baseUrl: s.url, model: "gpt-4.1", api: "chat" });
    assert.equal((await c([user("a")], [], { onText: () => {} })).content, "chat ok");
    assert.ok("stream_options" in s.seen[3].body && !("stream_options" in s.seen[4].body));
  } finally { s.close(); }
});

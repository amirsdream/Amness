import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, withCard, type Event, type Message, type Model } from "../src/index.ts";
import { findTextCalls, withoutCalls } from "../src/rescue.ts";

const ran: string[] = [];
const read = defineTool<{ path: string; limit?: number }>({ name: "read_file", description: "read", schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "integer" } } }, run: ({ path, limit }) => (ran.push(`${path}${limit ? `@${limit}` : ""}`), `text of ${path}`) });
const say = (content: string): Message => ({ role: "assistant", content });
const scripted = (...replies: Message[]): Model => async () => replies.shift() ?? { role: "assistant", content: null, tool_calls: [{ id: "end", function: { name: "finish", arguments: '{"summary":"ok"}' } }] };

const SHAPES: [string, string][] = [
  ["tool_call tag", 'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>'],
  ["function tag (JSON)", '<function=read_file>{"path": "a.ts"}</function>'],
  ["function tag (XML parameters)", "<function=read_file>\n<parameter=path>\na.ts\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>"],
  ["TOOL_CALLS", '[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a.ts"}}]'],
  ["python_tag", '<|python_tag|>{"name": "read_file", "parameters": {"path": "a.ts"}}'],
  ["fenced JSON", 'I will read it:\n```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```'],
  ["bare JSON", '{"name": "read_file", "arguments": {"path": "a.ts"}}'],
  ["wrong case name", '<tool_call>{"name": "Read_File", "arguments": {"path": "a.ts"}}</tool_call>'],
];

test("findTextCalls: each shape gives one candidate; withoutCalls leaves the prose", () => {
  for (const [what, text] of SHAPES) { const c = findTextCalls(text); assert.equal(c.length, 1, what); assert.equal(c[0].name.toLowerCase(), "read_file", what); assert.equal(JSON.parse(c[0].args).path, "a.ts", what); }
  assert.equal(withoutCalls(SHAPES[0][1], findTextCalls(SHAPES[0][1])), "Let me look.");
  assert.deepEqual(findTextCalls("I could call read_file on a.ts next, or grep for it."), []);
  assert.deepEqual(findTextCalls('The config looks like {"name": "app", "port": 3000} in this repo.'), []);   // JSON inside a sentence is not a call
});

test("with textToolCalls on, each shape runs the tool once and counts one rescue", async () => {
  for (const [what, text] of SHAPES) {
    ran.length = 0; const ev: Event[] = [];
    const r = await createHarness({ model: withCard(scripted(say(text)), { caps: { textToolCalls: true } }), tools: [read], onEvent: (e) => ev.push(e) }).run("read a.ts");
    assert.equal(r.finished, true, what); assert.equal(ran.length, 1, what); assert.match(ran[0], /^a\.ts/, what);
    const reps = ev.filter((e) => e.kind === "repair" && /rescued/.test((e as any).detail)); assert.equal(reps.length, 1, what);
    assert.ok(!ev.some((e) => e.kind === "nudge"), `${what}: no nudge`);
  }
  assert.deepEqual(ran, ["a.ts"]);
});

test("rescue never runs an unknown tool or invalid arguments, and is off unless the model's card or the option turns it on", async () => {
  ran.length = 0;
  await createHarness({ model: withCard(scripted(say('<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>'), say('<tool_call>{"name": "read_file", "arguments": {"limit": 3}}</tool_call>')), { caps: { textToolCalls: true } }), tools: [read], maxSteps: 4 }).run("go");
  assert.deepEqual(ran, []);
  const ev: Event[] = [];
  await createHarness({ model: scripted(say(SHAPES[0][1])), tools: [read], maxSteps: 3, onEvent: (e) => ev.push(e) }).run("read a.ts");
  assert.deepEqual(ran, []); assert.ok(!ev.some((e) => e.kind === "repair"));
  await createHarness({ model: scripted(say(SHAPES[0][1])), tools: [read], textToolCalls: true }).run("read a.ts");
  assert.deepEqual(ran, ["a.ts"]);
});

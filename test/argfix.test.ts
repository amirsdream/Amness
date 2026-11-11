import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, type Message, type Model, type Event } from "../src/index.ts";
import { coerce, parseArgs } from "../src/schema.ts";
import { exactName } from "../src/context.ts";
import { misshape } from "../src/chaos.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] });
const scripted = (...replies: Message[]) => { const seen: Message[][] = []; const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return replies.shift()!; }; return { model, seen }; };
const toolMsgs = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);
let runs = 0;
const edit = defineTool<{ path: string; line: number; all?: boolean; tags?: string[] }>({
  name: "edit_line", description: "edit", run: (a) => { runs++; return `ok ${a.path}:${a.line} all=${a.all ?? false} tags=${(a.tags ?? []).join("|")}`; },
  schema: { type: "object", required: ["path", "line"], additionalProperties: false, properties: { path: { type: "string" }, line: { type: "integer" }, all: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } },
});

test("parseArgs: strict JSON untouched; each repair shape gives the object and names the repair", () => {
  assert.deepEqual(parseArgs('{"a":1}'), { args: { a: 1 }, fixes: [] });
  assert.deepEqual(parseArgs(""), { args: {}, fixes: [] });
  const ok = (raw: string, want: unknown, fix: RegExp) => { const r = parseArgs(raw); assert.ok(!("error" in r), raw); assert.deepEqual((r as any).args, want); assert.match((r as any).fixes.join(" "), fix); };
  ok('{"a":1,}', { a: 1 }, /trailing commas/);
  ok("{'a': 'it''s'}".replace("''", "\\'"), { a: "it's" }, /single quotes/);
  ok('{"a":"line1\nline2"}', { a: "line1\nline2" }, /line breaks/);
  ok(JSON.stringify(JSON.stringify({ a: 1 })), { a: 1 }, /as a JSON string/);
  ok('{"arguments": {"a": 1}}', { a: 1 }, /unwrapped from "arguments"/);
  ok('{"parameters": "{\\"a\\": 1}"}', { a: 1 }, /unwrapped from "parameters"/);
  ok('Here you go: {"a": 1}', { a: 1 }, /extra text/);
  assert.ok("error" in parseArgs("{oops"));
  assert.ok("error" in parseArgs("[1,2]"));
});

test("coerce: changes types only where the meaning is clear, never invents values", () => {
  const s = edit.schema;
  assert.deepEqual(coerce({ path: "a", line: "12", all: "TRUE", tags: "x" }, s).value, { path: "a", line: 12, all: true, tags: ["x"] });
  assert.deepEqual(coerce({ path: "a", line: 3, all: null }, s).value, { path: "a", line: 3 });             // optional null dropped
  assert.deepEqual(coerce({ path: "a", line: "1.5" }, s).value, { path: "a", line: "1.5" });              // not an integer: left for the error
  assert.deepEqual(coerce({ path: "a", line: "twelve" }, s).value, { path: "a", line: "twelve" });
  assert.deepEqual(coerce({ path: "a", line: 1, tags: '["p","q"]' }, s).value, { path: "a", line: 1, tags: ["p", "q"] });
  assert.deepEqual(coerce({ line: 1 }, s), { value: { line: 1 }, fixes: [] });                           // missing required: no guess
  assert.deepEqual(coerce({ path: 7, line: 1 }, s).value, { path: 7, line: 1 });                        // number to string: not done
});

test("exactName: corrects only an unambiguous near-miss", () => {
  const names = ["read_file", "write_file", "edit_file", "grep", "sh", "finish"];
  assert.equal(exactName("Read_File", names), "read_file");
  assert.equal(exactName("read-file", names), "read_file");
  assert.equal(exactName("readfile", names), "read_file");
  assert.equal(exactName("read_fil", names), "read_file");
  assert.equal(exactName("grepp", names), "grep");
  assert.equal(exactName("xfile", names), undefined);
  assert.equal(exactName("s", names), undefined);
  assert.equal(exactName("edit_files", ["edit_file", "edit_filez"]), undefined);                        // two candidates: only suggest
});

test("harness: repairable calls run once, with one repair event and a note; the history holds the corrected call", async () => {
  runs = 0;
  const ev: Event[] = [];
  const { model, seen } = scripted(
    call("edit_line", '{"arguments": {"path": "a.ts", "line": "4"}}'),
    call("Edit_Line", { path: "b.ts", line: 2, all: "true", tags: "t" }),
    call("edit_line", '{"path": "c.ts", "line": 9,}'),
    call("finish", { summary: "done" }),
  );
  const r = await createHarness({ model, tools: [edit], onEvent: (e) => ev.push(e) }).run("t");
  assert.equal(r.text, "done");
  assert.equal(runs, 3);
  const t = toolMsgs(seen);
  assert.match(t[0], /^ok a\.ts:4/); assert.match(t[0], /note: your call was corrected/);
  assert.match(t[1], /^ok b\.ts:2 all=true tags=t/); assert.match(t[1], /tool name "Edit_Line" → "edit_line"/);
  assert.match(t[2], /^ok c\.ts:9/);
  const reps = ev.filter((e) => e.kind === "repair") as Extract<Event, { kind: "repair" }>[];
  assert.equal(reps.length, 3); assert.ok(reps.every((e) => e.fixed));
  const fixedCall = seen.at(-1)!.find((m) => m.tool_calls?.[0]?.function.name === "edit_line" && m.tool_calls[0].function.arguments.includes("b.ts"));
  assert.ok(fixedCall, "the corrected call is what goes back to the model");
});

test("harness: an invalid call still errors as before, and malformed JSON is counted as a repair", async () => {
  runs = 0;
  const ev: Event[] = [];
  const { model, seen } = scripted(call("edit_line", "{oops"), call("edit_line", { path: "a", line: "x" }), call("finish", { summary: "s" }));
  await createHarness({ model, tools: [edit], onEvent: (e) => ev.push(e) }).run("t");
  assert.equal(runs, 0);
  const t = toolMsgs(seen);
  assert.match(t[0], /not valid JSON/); assert.match(t[1], /\.line: expected integer, got string/);
  const reps = ev.filter((e) => e.kind === "repair") as Extract<Event, { kind: "repair" }>[];
  assert.equal(reps.length, 2); assert.ok(reps.every((e) => !e.fixed));
});

test("harness: with argfix off, nothing is corrected", async () => {
  runs = 0;
  const { model, seen } = scripted(call("edit_line", { path: "a", line: "4" }), call("finish", { summary: "s" }));
  await createHarness({ model, tools: [edit], off: ["argfix"] }).run("t");
  assert.equal(runs, 0); assert.match(toolMsgs(seen)[0], /expected integer/);
});

test("harness: risky tools show the corrected arguments in the approval prompt", async () => {
  const asked: unknown[] = [];
  const risky = defineTool<{ n: number }>({ name: "launch", description: "x", risky: true, run: ({ n }) => `launched ${n}`, schema: { type: "object", required: ["n"], properties: { n: { type: "number" } } } });
  const { model } = scripted(call("launch", { n: "3" }), call("finish", { summary: "s" }));
  await createHarness({ model, tools: [risky], approve: async (c) => { asked.push(c.args); return true; } }).run("t");
  assert.deepEqual(asked, [{ n: 3 }]);
});

test("chaos argshape: every shape it produces is repaired back to the original", () => {
  const orig = { path: "a.ts", line: 4, all: true };
  for (let i = 0; i < 4; i++) {
    const r = parseArgs(misshape(JSON.stringify(orig), i)); assert.ok(!("error" in r), String(i));
    assert.deepEqual(coerce((r as any).args, edit.schema).value, orig, String(i));
  }
});

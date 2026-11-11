import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, createHarness, defineTool, runDoctor, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `s${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const ran: string[] = [];
const mk = (name: string, o: { risky?: boolean } = {}) => defineTool<{ x: number }>({ name, description: `the ${name} tool`, deferred: true, risky: o.risky, schema: { type: "object", required: ["x"], properties: { x: { type: "integer" } } }, run: ({ x }) => (ran.push(`${name}:${x}`), `${name} ok ${x}`) });
const core = defineTool<{ p: string }>({ name: "read", description: "read", readOnly: true, schema: { type: "object", properties: { p: { type: "string" } } }, run: () => "text" });
const reg = () => new Registry([core, mk("alpha"), mk("beta"), mk("gamma", { risky: true })]);

async function session(stable: boolean, script: Message[], approve?: (r: { name: string; args: any }) => boolean) {
  const lists: string[] = [], outs: string[][] = [];
  const model: Model = async (msgs, specs) => { lists.push(JSON.stringify(specs)); outs.push(msgs.filter((m) => m.role === "tool").map((m) => m.content!)); return script.shift() ?? call("finish", { summary: "done" }); };
  await createHarness({ model, tools: reg(), stableTools: stable, approve: approve ? async (r) => approve(r) : undefined }).run("go");
  return { lists, last: outs.at(-1)! };
}

test("stable tools: the tool list is identical in every request while three deferred tools are found and used", async () => {
  ran.length = 0;
  const s = await session(true, [call("tool_search", { query: "alpha beta" }), call("call_tool", { name: "alpha", args: { x: 1 } }), call("beta", { x: 2 }), call("call_tool", { name: "gamma", args: { x: 3 } })], () => true);
  assert.deepEqual(ran, ["alpha:1", "beta:2", "gamma:3"]);
  assert.equal(new Set(s.lists).size, 1, "the tool list never changed");
  assert.match(s.lists[0], /"call_tool"/);
  assert.match(s.last[0], /Found\. Run one with call_tool/);
});

test("without stable tools, the same session changes the tool list (the control)", async () => {
  ran.length = 0;
  const s = await session(false, [call("tool_search", { query: "alpha" }), call("alpha", { x: 1 })]);
  assert.ok(new Set(s.lists).size > 1); assert.deepEqual(ran, ["alpha:1"]);
});

test("call_tool refuses unknown tools and invalid arguments like a direct call, and approvals see the real tool", async () => {
  ran.length = 0; const asked: string[] = [];
  const s = await session(true, [call("call_tool", { name: "nope", args: {} }), call("call_tool", { name: "alpha", args: { x: "not a number" } }), call("call_tool", { args: { x: 1 } }), call("call_tool", { name: "gamma", args: { x: 5 } })], (r) => (asked.push(`${r.name}:${JSON.stringify(r.args)}`), false));
  assert.deepEqual(ran, []);
  assert.match(s.last[0], /unknown tool "nope"/); assert.match(s.last[1], /\.x: expected integer/); assert.match(s.last[2], /call_tool needs/); assert.match(s.last[3], /^DENIED/);
  assert.deepEqual(asked, ['gamma:{"x":5}']);
});

test("amness doctor measures how much faster a repeated prefix is and suggests it as cacheFactor", async () => {
  let seen = 0;
  const m: Model = async (msgs, tools) => {
    if (!tools.length) { await new Promise((r) => setTimeout(r, seen++ % 2 === 0 ? 300 : 60)); return { role: "assistant", content: "OK" }; }
    return { role: "assistant", content: "no" };
  };
  const r = await runDoctor(m);
  assert.ok(r.cacheFactor !== undefined && r.cacheFactor < 0.5, String(r.cacheFactor));
  assert.equal(r.suggest.cacheFactor, r.cacheFactor);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDoctor, runDoctor, type Message, type Model } from "../src/index.ts";

let n = 0;
type Style = { text?: boolean; prose?: boolean; noStop?: boolean; noRecover?: boolean };
/** A scripted model that answers each check the way a model of this style would. */
const scripted = (st: Style = {}): Model => async (msgs, tools, opts) => {
  const last = msgs.at(-1)!, user = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  const mk = (name: string, args: unknown): Message => st.text
    ? { role: "assistant", content: `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`, usage: { total_tokens: 50 } }
    : { role: "assistant", content: null, tool_calls: [{ id: `d${++n}`, function: { name, arguments: JSON.stringify(args) } }], usage: { total_tokens: 50 } };
  if (st.prose && tools.length && opts?.toolChoice !== "required") return { role: "assistant", content: "I would call the tool now." };
  if (!tools.length) return { role: "assistant", content: "OK" };
  const t = tools.map((x) => x.name);
  if (t.includes("probe_record")) return mk("probe_record", { s: "amness", n: 42, b: true, list: ["a", "b"], obj: { k: "v" } });
  if (t.includes("probe_echo")) return st.text ? { role: "assistant", content: `<tool_call>{"name":"probe_echo","arguments":{"x":1}}</tool_call>\n<tool_call>{"name":"probe_echo","arguments":{"x":2}}</tool_call>` } : { role: "assistant", content: null, tool_calls: [1, 2].map((x) => ({ id: `e${++n}${x}`, function: { name: "probe_echo", arguments: JSON.stringify({ x }) } })) };
  if (t.includes("step_1")) {
    if (last.role === "user") return mk("step_1", { token: "start" });
    const r = last.content ?? "", next = /call (step_\d) with token "(\w+)"/.exec(r);
    if (next) return mk(next[1], { token: next[2] });
    return st.noStop ? mk("step_1", { token: "start" }) : { role: "assistant", content: "DONE" };
  }
  if (t.includes("probe_range")) {
    if (last.role === "tool") return mk("probe_range", { n: st.noRecover ? 42 : 7 });
    return mk("probe_range", { n: /42/.test(user) ? 42 : 3 });
  }
  return { role: "assistant", content: "?" };
};

test("a model that calls tools properly passes every check and qualifies for every job", async () => {
  const r = await runDoctor(scripted(), { stated: 131072 });
  assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.id), []);
  for (const role of ["main", "edit", "explore", "review", "compact", "quarantine", "approve"]) assert.ok(r.qualified.includes(role), role);
  assert.deepEqual(r.suggest, {}); assert.equal(r.textCalls, false);
  assert.match(formatDoctor("server:lab/qwen", r), /qualified for: .*main/);
});

test("a model that writes its calls as text is still qualified, and the report says to turn on textToolCalls", async () => {
  const r = await runDoctor(scripted({ text: true }));
  assert.equal(r.textCalls, true); assert.equal(r.suggest.textToolCalls, true);
  assert.ok(r.qualified.includes("explore"));
  assert.equal(r.checks.find((c) => c.id === "format")!.pass, false);
});

test("a model that never makes a valid call fails the typed check three times and is kept out of tool jobs", async () => {
  const r = await runDoctor(scripted({ prose: true }));
  const typed = r.checks.find((c) => c.id === "typed")!;
  assert.equal(typed.pass, false); assert.match(typed.detail, /failed 3 times/);
  assert.deepEqual(r.qualified.sort(), ["compact", "quarantine"]);
  assert.ok(r.notFor.some((x) => x.role === "main") && r.notFor.some((x) => x.role === "explore"));
});

test("a model that does not stop after the chain, or does not correct a call, is not qualified for the main loop and is suggested tier local", async () => {
  const a = await runDoctor(scripted({ noStop: true }));
  assert.equal(a.checks.find((c) => c.id === "chain")!.pass, false); assert.ok(!a.qualified.includes("explore")); assert.equal(a.suggest.tier, "local");
  const b = await runDoctor(scripted({ noRecover: true }));
  assert.equal(b.checks.find((c) => c.id === "recover")!.pass, false); assert.ok(b.qualified.includes("explore")); assert.ok(!b.qualified.includes("main"));
});

test("a model that throws is reported per check, not as a crash", async () => {
  const r = await runDoctor(async () => { throw new Error("HTTP 500 boom"); });
  assert.ok(r.checks.length >= 7); assert.ok(r.checks.filter((c) => c.id !== "window" && c.id !== "format").every((c) => !c.pass));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodeAgent, createHarness, defineTool, routedModel, withCard, withFallback, type Message, type Model, type ModelOpts } from "../src/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `k${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const CHARS = (msgs: Message[], specs: unknown[]) => msgs.reduce((k, m) => k + (m.content?.length ?? 0) + (m.tool_calls ?? []).reduce((j, c) => j + c.function.arguments.length + c.function.name.length, 0) + 12, 0) + JSON.stringify(specs).length;
/** A server with a window it enforces (3 characters per token, harsher than the harness's estimate). */
function server(window: number, steps: number) {
  let i = 0, peak = 0, notes = 0;
  const model: Model = async (msgs, specs) => {
    const tokens = Math.ceil(CHARS(msgs, specs) / 3); peak = Math.max(peak, tokens);
    if (tokens > window) throw new Error(`This model's maximum context length is ${window} tokens. However, you requested ${tokens} tokens in the messages.`);
    if (msgs.at(-1)?.content?.startsWith("Your context is about to be reset")) { notes++; return { role: "assistant", content: "GOAL: read every file\nDONE: files 1.." + i + "\nNEXT: keep reading" }; }
    if (i >= steps) return call("finish", { summary: "all read" });
    i++; return call("read", { path: `file${i}.txt` });
  };
  return { model, stats: () => ({ peak, notes }) };
}
const read = defineTool<{ path: string }>({ name: "read", description: "Read a file. " + "It returns the text of the file. ".repeat(40), schema: { type: "object", properties: { path: { type: "string" } } }, run: ({ path }) => `contents of ${path}\n` + Array.from({ length: 120 }, (_, k) => `line ${k} of ${path}`).join("\n") });
const SYSTEM = "You are an agent. ".repeat(120);

test("a harness whose model card says 8,192 keeps every request inside it, with no contextWindow option", async () => {
  const s = server(8192, 40);
  const r = await createHarness({ model: withCard(s.model, { window: () => 8192 }), tools: [read], system: SYSTEM, maxSteps: 60, stagnationTurns: 0 }).run("read every file");
  assert.equal(r.finished, true); assert.ok(s.stats().peak <= 8192, `peak ${s.stats().peak}`);
});

test("a compact model with a smaller window than the main model gets a handoff request that fits its own window", async () => {
  const main = server(7_000, 150), small = server(3_500, 0);
  const r = await createHarness({ model: withCard(main.model, { window: () => 7_000 }), compactModel: withCard(small.model, { window: () => 3_500 }), tools: [read], system: "short", maxSteps: 200, stagnationTurns: 0 }).run("TASK: read every file");
  assert.equal(r.finished, true);
  assert.ok(small.stats().notes >= 1, "the compact model wrote the notes");
  assert.ok(small.stats().peak <= 3_500, `the compact model was sent ${small.stats().peak} tokens`);
});

test("card profile: per-call settings fill in what the caller did not set; the caller wins; toolChoice only with tools", async () => {
  const seen: ModelOpts[] = [];
  const raw: Model = async (_m, _t, o) => (seen.push(o ?? {}), { role: "assistant", content: "x" });
  const m = withCard(raw, { profile: { toolChoice: "required", thinkingBudget: 512, keepThinking: true, request: { temperature: 0.6, top_k: 20 } } });
  const spec = [{ name: "t", description: "", parameters: { type: "object" as const } }];
  await m([], spec); await m([], []); await m([], spec, { toolChoice: "auto", thinkingBudget: 0, request: { temperature: 1 } });
  assert.deepEqual([seen[0].toolChoice, seen[0].thinkingBudget, seen[0].keepThinking, seen[0].request], ["required", 512, true, { temperature: 0.6, top_k: 20 }]);
  assert.equal(seen[1].toolChoice, undefined);
  assert.deepEqual([seen[2].toolChoice, seen[2].thinkingBudget, seen[2].request], ["auto", 0, { temperature: 1, top_k: 20 }]);
});

test("a role model's profile applies to that role's calls only: the explorer is forced to call tools, the chat model is not", async () => {
  const d = mkdtempSync(join(tmpdir(), "amness-card-"));
  const mainOpts: (ModelOpts | undefined)[] = [], subOpts: (ModelOpts | undefined)[] = [];
  const lead = [call("task", { description: "look around" }), { role: "assistant" as const, content: "done" }];
  const main = withCard(async (_m, _t, o) => (mainOpts.push(o), lead.shift()!), { id: "big", profile: {} });
  const explorer = withCard(async (_m, _t, o) => (subOpts.push(o), call("finish", { summary: "found" })), { id: "small", profile: { toolChoice: "required", thinkingBudget: 0 } });
  const a = createCodeAgent({ model: main, models: { explore: explorer }, cwd: d, memory: false, guidance: false, chat: true, index: false, permissions: { mode: () => "default" } });
  await a.chat([], "explore please");
  assert.ok(subOpts.length >= 1 && subOpts.every((o) => o?.toolChoice === "required" && o?.thinkingBudget === 0));
  assert.ok(mainOpts.length >= 1 && mainOpts.every((o) => o?.toolChoice !== "required" && o?.thinkingBudget === undefined));
});

test("profile loop settings come from the card when the options do not set them", async () => {
  let calls = 0;
  const m = withCard(async () => (calls++, call("read", { path: `f${calls}` })), { profile: { maxSteps: 3, off: ["loop"] } });
  const r = await createHarness({ model: m, tools: [read], stagnationTurns: 0 }).run("go");
  assert.equal(r.finished, false); assert.equal(calls, 3);
});

test("fallback pair of Claude and a local model: history may be rewritten only after the local model answered", async () => {
  let fail = false;
  const claude: Model = Object.assign(async () => { if (fail) throw Object.assign(new Error("overloaded"), { status: 529 }); return { role: "assistant" as const, content: "claude" }; }, { appendOnly: true });
  const local = withCard(async () => ({ role: "assistant" as const, content: "local" }), { id: "qwen", tier: "local" as const });
  const pair = withFallback(withCard(claude, { id: "claude-opus-5-5" }), local);
  assert.equal(pair.appendOnly, true); assert.equal(pair.card?.id, "claude-opus-5-5");
  fail = true; assert.equal((await pair([], [])).content, "local");
  assert.ok(!pair.appendOnly); assert.equal(pair.card?.id, "qwen");
  fail = false; await pair([], []);
  assert.equal(pair.appendOnly, true);
});

test("router: the cheap tier is skipped when its window cannot hold the conversation; appendOnly follows the tier in use", async () => {
  const who: string[] = [];
  const strong: Model = Object.assign(async (m: Message[]) => (who.push("strong"), call("read", { path: `s${m.length}` })), { appendOnly: true });
  const cheap = withCard(async (m: Message[]) => (who.push("cheap"), call("read", { path: `c${m.length}` })), { window: () => 300 });
  const r = routedModel({ strong, cheap, prices: { strong: { input: 5, output: 25 }, cheap: { input: 0.1, output: 0.5 } } });
  const big = "x".repeat(4000), hist: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
  for (let i = 0; i < 5; i++) { const a = call("read", { path: `p${i}` }); hist.push(a, { role: "tool", tool_call_id: a.tool_calls![0].id, content: big }); }
  await r(hist, [{ name: "read", description: "", parameters: { type: "object" } }]);
  assert.deepEqual(who, ["strong"]);
  assert.equal(r.appendOnly, true);
});

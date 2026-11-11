import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, withCard, type Event, type Message, type Model } from "../src/index.ts";

let n = 0;
const read = defineTool<{ path: string }>({ name: "read", description: "Read a file.", schema: { type: "object", properties: { path: { type: "string" } } }, run: ({ path }) => `contents of ${path}\n` + "word ".repeat(2500) });
/** A server that reports a prompt count: `report(trueTokens)` decides what it says. */
const server = (report: (tokens: number) => number, steps = 8) => {
  let i = 0;
  const model: Model = async (msgs) => {
    const tokens = Math.ceil(msgs.reduce((k, m) => k + (m.content?.length ?? 0), 0) / 3.5);
    const usage = { prompt_tokens: report(tokens), completion_tokens: 10, total_tokens: report(tokens) + 10 };
    if (msgs.at(-1)?.content?.startsWith("Your context is about to be reset")) return { role: "assistant", content: "GOAL: read\nNEXT: more", usage };
    if (i++ >= steps) return { role: "assistant", content: null, tool_calls: [{ id: `f${++n}`, function: { name: "finish", arguments: '{"summary":"done"}' } }], usage };
    return { role: "assistant", content: null, tool_calls: [{ id: `r${++n}`, function: { name: "read", arguments: JSON.stringify({ path: `f${i}.txt` }) } }], usage };
  };
  return model;
};

test("a server that silently cuts the prompt to 4,096 tokens is noticed: the window drops to about that, once, with the fix named", async () => {
  const ev: Event[] = [], learned: number[] = [];
  const m = withCard(server((t) => Math.min(t, 4096)), { id: "qwen", provider: "ollama" });
  const r = await createHarness({ model: m, tools: [read], maxSteps: 30, stagnationTurns: 0, onEvent: (e) => ev.push(e), onWindow: (w) => learned.push(w) }).run("read the files");
  assert.equal(r.finished, true);
  assert.equal(learned.length, 1); assert.ok(learned[0] >= 4096 && learned[0] < 4500, String(learned[0]));
  const notes = ev.filter((e) => e.kind === "hook" && (e as any).event === "Window");
  assert.equal(notes.length, 1); assert.match((notes[0] as any).detail, /raise the server's context length/);
});

test("a low count that keeps moving (a server reporting only the uncached part) does not trigger it; nor does a hosted provider", async () => {
  for (const [rep, provider] of [[(t: number) => 1500 + (t % 997), "custom"], [(t: number) => Math.min(t, 4096), "anthropic"]] as const) {
    const ev: Event[] = [], learned: number[] = [];
    await createHarness({ model: withCard(server(rep), { id: "x", provider }), tools: [read], maxSteps: 30, stagnationTurns: 0, onEvent: (e) => ev.push(e), onWindow: (w) => learned.push(w) }).run("read the files");
    assert.deepEqual(learned, [], provider); assert.ok(!ev.some((e) => e.kind === "hook" && (e as any).event === "Window"), provider);
  }
});

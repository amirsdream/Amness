import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer, createHarness, defineTool, formatReplay, readTrace, replayFile, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, tool_calls: [{ id: "p" + ++n, function: { name, arguments: JSON.stringify(args) } }] });

/** Record a real run (a model that repeats itself, then recovers) into a trace file. */
async function record(): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), "amness-rp-")), "t.jsonl"), tr = new Tracer({ file, sessionId: "r" });
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, readOnly: true, run: (a: any) => `result for ${a.i}` });
  const q = [call("t", { i: 1 }), call("t", { i: 1 }), call("t", { i: 1 }), call("t", { i: 2 }), call("finish", { summary: "done" })];
  const model: Model = async () => q.shift()!;
  await createHarness({ model, tools: [t], record: true, onEvent: (e) => tr.event(e) }).run("do the thing"); await tr.close();
  return file;
}

test("replay: the trace holds the run's messages, model turns and tool results", async () => {
  const runs = readTrace(await record());
  assert.equal(runs.length, 1); assert.equal(runs[0].models.length, 5); assert.deepEqual(runs[0].tools, ["t"]);
  assert.equal(runs[0].messages.at(-1)!.content, "do the thing"); assert.deepEqual(runs[0].results.get('t{"i":1}'), ["result for 1", "result for 1"]);
  assert.ok(runs[0].lines.some((l) => l.kind === "loop") && runs[0].lines.some((l) => l.kind === "finish"));
});

test("replay: an unchanged harness reproduces the recorded behaviour exactly, with no model and no real tools", async () => {
  const [r] = await replayFile(await record());
  assert.equal(r.same, true, JSON.stringify([r.onlyRecorded, r.onlyReplayed])); assert.ok(r.result.finished && r.recorded.length >= 2);
  assert.match(formatReplay([r]), /identical harness behaviour/);
});

test("replay: a changed guard shows up as the exact difference it makes (the loop guard switched off here)", async () => {
  const [r] = await replayFile(await record(), { off: ["loop"] });
  assert.equal(r.same, false); assert.ok(r.onlyRecorded.some((s) => /^loop · /.test(s)), JSON.stringify(r.onlyRecorded));
  const text = formatReplay([r]); assert.match(text, /1 difference|difference\(s\)/); assert.match(text, /- recorded only: loop/);
});

test("replay: traces without recorded messages say so", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "amness-rp2-")), "old.jsonl"); writeFileSync(f, '{"kind":"turn","t":"x","ms":1}\n');
  assert.match(formatReplay(await replayFile(f)), /no recorded runs/);
});

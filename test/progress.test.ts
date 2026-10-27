import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker, countFailures, createHarness, defineTool, type Message, type Model } from "../src/index.ts";

test("countFailures reads the common runners, tsc and lint, and falls back to the exit code", () => {
  assert.equal(countFailures("npm test", "exit=1\nTests: 3 failed, 9 passed, 12 total"), 3);
  assert.equal(countFailures("pytest", "exit=1\n== 2 failed, 5 passed in 0.3s =="), 2);
  assert.equal(countFailures("node --test", "exit=1\nℹ pass 10\nℹ fail 4\n"), 4);
  assert.equal(countFailures("npx tsc --noEmit", "exit=2\na.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2304: y\n"), 2);
  assert.equal(countFailures("go test ./...", "exit=1\nFAIL\tpkg\t0.1s\n"), 1);                                  // no readable count: the failing exit code counts as 1
  assert.equal(countFailures("npm test", "exit=0\n12 passing"), 0);
  assert.equal(countFailures("ls -la", "exit=0\n"), undefined);                                                 // not a check
});

test("tracker: real improvements reset the clock; flat failures, repeated reads and flip-flopping edits do not", () => {
  const t = new ProgressTracker(), run = (n: number) => ({ calls: [{ name: "sh", args: { cmd: "npm test" }, result: `exit=1\n${n} failed` }], edits: [] as { path: string; diff: string }[] });
  assert.ok(t.observe(run(5)).length);                                    // first measurement is information
  assert.equal(t.observe(run(5)).length, 0); assert.equal(t.stale, 1);
  assert.equal(t.observe(run(5)).length, 0); assert.equal(t.stale, 2);
  assert.match(t.observe(run(3))[0], /failures down to 3/); assert.equal(t.stale, 0);
  assert.equal(t.observe(run(4)).length, 0);                              // worse than the best so far is not progress
  const d1 = "@@\n-const x = 1;\n+const x = 2;\n", d2 = "@@\n-const x = 2;\n+const x = 1;\n";
  assert.match(t.observe({ calls: [], edits: [{ path: "a.ts", diff: d1 }] })[0], /first edit to a.ts/);
  assert.equal(t.observe({ calls: [], edits: [{ path: "a.ts", diff: d2 }] }).length, 0);                // undoing the change is not new work
  assert.equal(t.observe({ calls: [], edits: [{ path: "a.ts", diff: d1 }] }).length, 0);                // and neither is redoing it
  assert.match(t.observe({ calls: [], edits: [{ path: "a.ts", diff: "@@\n-const y = 1;\n+const y = 3;\n" }] })[0], /new change to a.ts/);
  const r = { name: "read_file", args: { path: "a.ts" }, result: "1\tx" };
  assert.match(t.observe({ calls: [r], edits: [] })[0], /read something new/); assert.equal(t.observe({ calls: [r], edits: [] }).length, 0);
  assert.match(t.observe({ calls: [{ name: "sh", args: { cmd: "npm test" }, result: "exit=0\n" }], edits: [] })[0], /the checks pass/);
});

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "s" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
const tools = (results: string[]) => { let i = 0; return [defineTool({ name: "sh", description: "", schema: { type: "object" }, run: () => results[Math.min(i++, results.length - 1)] }),
  defineTool({ name: "poke", description: "", schema: { type: "object" }, run: (a: any, ctx) => (ctx.emit?.({ kind: "edit", path: "f.ts", created: false, added: 1, removed: 1, diff: a.flip ? "@@\n-a\n+b\n" : "@@\n-b\n+a\n" }), "poked") })]; };

test("harness: a loop that acts but never improves is told to reflect, then stopped; a loop that improves is left alone", async () => {
  const q = [call("poke", { flip: true }), ...Array.from({ length: 30 }, (_, i) => (i % 2 ? call("poke", { flip: i % 4 === 1 }) : call("sh", { cmd: `npm test -- --run ${i}` })))];
  const seen: Message[][] = [], ev: any[] = [];
  const model: Model = async (m) => (seen.push(m.map((x) => ({ ...x }))), q.shift()!);
  const r = await createHarness({ model, tools: tools(["exit=1\n4 failed"]), stagnationTurns: 4, maxSteps: 40, onEvent: (e) => ev.push(e) }).run("fix");
  assert.equal(r.stopped, "stuck"); assert.match(r.text, /no measurable progress/);
  assert.ok(seen.some((m) => m.some((x) => x.role === "user" && /nothing measurable has improved/.test(x.content ?? ""))));
  assert.ok(ev.some((e) => e.kind === "nudge" && /stagnation/.test(e.detail)));
  // steady improvement: failures 5 -> 4 -> 3 -> 2 -> 1 -> 0 (with edits flipped back and forth in between) never triggers it
  const q2 = [...[5, 4, 3, 2, 1, 0].flatMap((_, i) => [call("poke", { flip: i % 2 === 0, tag: i }), call("sh", { cmd: "npm test" })]), call("finish", { summary: "done" })], ev2: any[] = [];
  const r2 = await createHarness({ model: async () => q2.shift()!, tools: tools(["exit=1\n5 failed", "exit=1\n4 failed", "exit=1\n3 failed", "exit=1\n2 failed", "exit=1\n1 failed", "exit=0\nok"]), stagnationTurns: 2, onEvent: (e) => ev2.push(e) }).run("fix");
  assert.ok(r2.finished && !ev2.some((e) => e.kind === "nudge" || e.kind === "loop"), JSON.stringify(ev2.filter((e) => e.kind === "nudge" || e.kind === "loop")));
  // switched off
  const q3 = Array.from({ length: 8 }, () => call("poke", { flip: true })); q3.push(call("finish", { summary: "." }));
  assert.ok((await createHarness({ model: async () => q3.shift()!, tools: tools(["x"]), stagnationTurns: 3, off: ["stagnation"], maxSteps: 20 }).run("x")).finished);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrate, evaluate, selfTest, type Case, type Row, type Variant } from "../src/index.ts";
import { rowsCost, runEval } from "../cli/evalcli.ts";

const fake = (name: string, pass: (c: Case, n: number) => string): Variant => {
  let n = 0;
  return { name, run: async (c) => ({ text: pass(c, n++), steps: 3, tokens: 12_000, prompt: 11_000, cached: 6_000 }) };
};

test("a check can read what the agent said when it finished", async () => {
  const c: Case = { name: "say-where", files: { "a.txt": "x" }, task: "create b.txt and tell me where it is", solution: { "b.txt": "y" }, solutionSummary: "Created ./b.txt",
    check: (dir, run) => (run?.text.includes("b.txt") ? true : "the summary does not name the file") };
  const { rows } = await evaluate([c], [fake("names-it", () => "Created ./b.txt"), fake("silent", () => "Done.")]);
  assert.deepEqual(rows.map((r) => [r.variant, r.pass]), [["names-it", true], ["silent", false]]);
  assert.match(rows.find((r) => r.variant === "silent")!.note!, /does not name the file/);
});

test("selftest uses solutionSummary: the check must fail on silence and pass with the reference summary", async () => {
  const mk = (solutionSummary?: string): Case => ({ name: "t", files: {}, task: "t", solution: {}, solutionSummary, check: (_d, run) => /b\.txt/.test(run?.text ?? "") });
  assert.equal((await selfTest([mk("Created b.txt")]))[0].ok, true);
  assert.equal((await selfTest([mk()]))[0].ok, false);                      // no reference summary: the check cannot pass, so the task is not sound
});

test("stop: no new sessions start once the hook returns a reason; the rest are reported as skipped", async () => {
  const cases: Case[] = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, files: {}, task: "t", check: () => true }));
  const { rows, stopped, skipped } = await evaluate(cases, [fake("v", () => "ok")], { stop: (rs) => (rs.length >= 2 ? "cap reached" : undefined) });
  assert.equal(rows.length, 2); assert.equal(stopped, "cap reached"); assert.equal(skipped, 4);
  const all = await evaluate(cases, [fake("v", () => "ok")], {});
  assert.equal(all.rows.length, 6); assert.equal(all.stopped, undefined); assert.equal(all.skipped, 0);
});

test("rowsCost prices prompt, cached and completion tokens separately, and gives null for an unknown model", () => {
  const row: Row = { case: "a", variant: "v", trial: 0, pass: true, steps: 1, tokens: 12_000, ms: 1, prompt: 11_000, cached: 6_000 };
  // Luna: $0.10 / $0.50 per million. 5000 fresh input + 6000 cached at a tenth + 1000 output
  assert.ok(Math.abs(rowsCost("gpt-6-luna", [row, row])! - 2 * (5000 * 0.1 + 6000 * 0.01 + 1000 * 0.5) / 1e6) < 1e-9);
  assert.equal(rowsCost("some-unknown-model", [row]), null);
});

test("calibrate: keeps tasks that baseline passes 30% to 70% of the time, flags the rest", () => {
  const rows = (name: string, passes: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ case: name, variant: "baseline", trial: i, pass: i < passes, steps: 1, tokens: 1, ms: 1 }));
  const r = calibrate([...rows("easy", 5, 5), ...rows("mid", 3, 5), ...rows("low-edge", 2, 5), ...rows("hard", 0, 5), ...rows("high-edge", 7, 10)]);
  const by = Object.fromEntries(r.map((x) => [x.case, x.verdict]));
  assert.deepEqual(by, { easy: "too easy", mid: "keep", "low-edge": "keep", hard: "too hard", "high-edge": "keep" });   // 2/5 = 40% and 7/10 = 70% are inside the band
  assert.equal(calibrate([{ ...rows("x", 1, 1)[0], excluded: "setup failed" }]).length, 0);                           // excluded runs never count
});

test("amness eval --max-cost: rejects a non-positive amount and a model with no known price", async () => {
  const deps = (modelName: string) => ({ model: () => ({}) as never, modelName, maxTokens: 1000, confirm: async () => true });
  const quiet = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try {
    assert.equal(await runEval(["--max-cost", "0", "--yes"], deps("gpt-6-luna")), 2);
    assert.equal(await runEval(["--max-cost", "1", "--yes"], deps("mystery-model")), 2);
  } finally { console.error = quiet; console.log = log; }
});

test("provenance: the task hash changes when a task or its check changes, and not otherwise", async () => {
  const { provenance } = await import("../cli/evalcli.ts");
  const a: Case = { name: "t", files: { "x.ts": "1" }, task: "do it", check: () => true };
  const same = provenance([{ ...a }]).suite, edited = provenance([{ ...a, task: "do it differently" }]).suite, otherCheck = provenance([{ ...a, check: () => false }]).suite;
  assert.equal(provenance([a]).suite, same);
  assert.notEqual(same, edited); assert.notEqual(same, otherCheck);
  assert.equal(provenance([a, { ...a, name: "u" }]).tasks, 2);
  assert.match(provenance([a]).commit ?? "0".repeat(40), /^[0-9a-f]{40}$/);          // a clone has a commit; an installed package has none
});

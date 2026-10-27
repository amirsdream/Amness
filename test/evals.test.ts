import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, bootstrap, builtinCases, evaluate, formatReport, harnessVariant, holm, loadCases, passAtK, passPowK, selfTest, signTest, variantNames, type Message, type Model, type Row } from "../src/index.ts";

const row = (variant: string, c: string, trial: number, pass: boolean, tokens = 1000): Row => ({ case: c, variant, trial, pass, steps: 5, tokens, ms: 100 });

test("stats: sign test, pass^k, pass@k, Holm, bootstrap are correct and reproducible", () => {
  assert.equal(signTest(0, 0), 1); assert.ok(Math.abs(signTest(8, 0) - 2 / 256) < 1e-12); assert.equal(signTest(5, 5), 1);
  assert.equal(passPowK(3, 3, 3), 1); assert.equal(passPowK(2, 3, 3), 0); assert.ok(Math.abs(passPowK(2, 3, 2) - 1 / 3) < 1e-12);
  assert.equal(passAtK(0, 3, 2), 0); assert.equal(passAtK(1, 3, 3), 1);
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((x) => +x.toFixed(2)), [0.03, 0.06, 0.06]);
  const xs = [1, 0, 1, 1, 0, 1, 1, 1], m = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length;
  assert.deepEqual(bootstrap(xs, m, { seed: 3 }), bootstrap(xs, m, { seed: 3 }));
  const ci = bootstrap(xs, m, { seed: 3 }); assert.ok(ci.lo <= 0.75 && ci.hi >= 0.75 && ci.lo >= 0.25 && ci.hi <= 1);
});

test("analyze: a variant that wins on most tasks is 'better'; a coin-flip difference is 'inconclusive'", () => {
  const rows: Row[] = [];
  for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) { rows.push(row("base", "t" + t, k, t < 3)); rows.push(row("good", "t" + t, k, t < 11, 800)); rows.push(row("noise", "t" + t, k, (t + k) % 2 === 0 ? t < 3 : t < 4)); }
  const a = analyze(rows, { baseline: "base" });
  const good = a.comparisons.find((c) => c.variant === "good")!, noise = a.comparisons.find((c) => c.variant === "noise")!;
  assert.equal(good.verdict, "better"); assert.ok(good.dPass > 0.5 && good.ci.lo > 0 && good.wins === 8 && good.losses === 0);
  assert.equal(noise.verdict, "inconclusive");
  assert.ok(a.stats.find((s) => s.variant === "good")!.pareto);
  assert.ok(!a.stats.find((s) => s.variant === "base")!.pareto);   // dominated: fewer passes, more tokens per solve
  assert.match(formatReport(a), /good\s+\+67 pts/);
});

test("analyze: per-task resampling, pass^k and tokens per solved task", () => {
  const rows = [row("a", "x", 0, true, 100), row("a", "x", 1, true, 100), row("a", "y", 0, true, 300), row("a", "y", 1, false, 300)];
  const s = analyze(rows, { k: 2 }).stats[0];
  assert.equal(s.passRate, 0.75); assert.equal(s.passPowK, 0.5);          // x always passes, y passes both attempts with p = 0
  assert.equal(s.tokensPerSolved, 800 / 3);
});

test("every built-in task is sound: its held-out check fails before the fix and passes with the reference solution", async () => {
  const res = await selfTest(builtinCases);
  assert.deepEqual(res.filter((r) => !r.ok), []);
});

test("selfTest catches a bad task (check passes without any fix)", async () => {
  const bad = [{ name: "trivial", files: { a: "x" }, task: "t", check: "true", solution: {} }];
  assert.equal((await selfTest(bad))[0].ok, false);
});

test("loadCases reads json tasks and rejects malformed ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-cases-"));
  writeFileSync(join(dir, "one.json"), JSON.stringify({ files: { "a.txt": "x" }, task: "do it", check: "test -f a.txt" }));
  assert.equal(loadCases(dir)[0].name, "one");
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ task: "no check" }));
  assert.throws(() => loadCases(dir), /needs "task"/);
});

test("variantNames: presets expand, bad names are rejected", () => {
  assert.deepEqual(variantNames("ab"), ["baseline", "full"]);
  assert.ok(variantNames("ablate").includes("full-index") && variantNames("ablate").length === 12);
  const m: Model = async () => ({ role: "assistant", content: "x" });
  assert.throws(() => harnessVariant(m, "nonsense"), /unknown variant/); assert.throws(() => harnessVariant(m, "full-bogus"), /unknown guard/);
});

test("end to end: variants run through the real harness with a scripted model, are judged by the held-out check, and report guard events", async () => {
  const c = builtinCases.find((x) => x.name === "off-by-one")!;
  let id = 0;
  const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, usage: { total_tokens: 100 }, tool_calls: [{ id: "e" + ++id, function: { name, arguments: JSON.stringify(args) } }] });
  const mk = (fix: boolean): Model => async (msgs) => {   // stateless: the script position is the number of assistant turns so far
    const n = msgs.filter((m) => m.role === "assistant").length, q = fix ? [call("read_file", { path: "sum.js" }), call("write_file", { path: "sum.js", content: c.solution!["sum.js"] }), call("finish", { summary: "fixed" })] : [call("finish", { summary: "done (not really)" })];
    return q[n] ?? call("finish", { summary: "." });
  };
  const good = { ...harnessVariant(mk(true), "full"), name: "fixer" }, lazy = { ...harnessVariant(mk(false), "full"), name: "lazy" };
  const { rows, analysis } = await evaluate([c], [good, lazy], { trials: 2, jobs: 2, baseline: "lazy" });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((r) => r.variant === "fixer").map((r) => r.pass), [true, true]);
  assert.deepEqual(rows.filter((r) => r.variant === "lazy").map((r) => r.pass), [false, false]);
  assert.ok(rows.find((r) => r.variant === "lazy")!.events!.rejected >= 1);          // the verify gate refused the false "done"
  assert.equal(analysis.stats.find((s) => s.variant === "fixer")!.passRate, 1);
  assert.equal(analysis.comparisons[0].variant, "fixer");
});

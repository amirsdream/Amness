import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_METRICS, analyze, evaluate, formatReport, gateCompare, type Case, type Row, type Variant } from "../src/index.ts";

const row = (v: string, c: string, trial: number, pass: boolean, tokens = 1000, metrics?: Record<string, number>): Row => ({ case: c, variant: v, trial, pass, steps: 3, tokens, ms: 1000, metrics });

test("custom metrics are recorded per run, averaged per variant, compared with a paired interval and shown in the report", async () => {
  const cases: Case[] = ["a", "b", "c", "d"].map((n) => ({ name: n, files: { "x.txt": "one\ntwo\n" }, task: "t", check: () => true }));
  const mk = (name: string, extra: number): Variant => ({ name, run: async (_c, dir) => { writeFileSync(join(dir, "x.txt"), "one\ntwo\n" + "new\n".repeat(extra)); return { text: "", steps: 2, tokens: 100, events: { tool: 4 } }; } });
  const { rows, analysis } = await evaluate(cases, [mk("small", 1), mk("big", 5)], { trials: 2, baseline: "small", metrics: { "diff-lines": BUILTIN_METRICS["diff-lines"], "tool-calls": BUILTIN_METRICS["tool-calls"], broken: () => { throw new Error("x"); } } });
  assert.ok(rows.every((r) => r.metrics!["diff-lines"] === (r.variant === "small" ? 1 : 5) && r.metrics!["tool-calls"] === 4 && !("broken" in r.metrics!)));        // a broken metric is dropped, the run survives
  assert.deepEqual(analysis.metricNames, ["diff-lines", "tool-calls"]);
  assert.equal(analysis.stats.find((s) => s.variant === "big")!.metrics["diff-lines"], 5);
  const c = analysis.comparisons[0]; assert.equal(c.metrics["diff-lines"].d, 4); assert.equal(c.metrics["tool-calls"].d, 0);
  assert.match(formatReport(analysis), /custom metrics[\s\S]*big\s+5\.00\s+Δ \+4\.00/);
});

test("regression gate: a clear drop fails, a noisy one only warns, a cost jump fails, a variant missing from the baseline is skipped", () => {
  const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"], mkRows = (v: string, passFn: (t: string, trial: number) => boolean, tokens = 1000) => tasks.flatMap((t) => [0, 1].map((tr) => row(v, t, tr, passFn(t, tr), tokens)));
  const base = mkRows("full", () => true);
  const drop = gateCompare(mkRows("full", () => false), base); assert.equal(drop[0].ok, false); assert.match(drop[0].lines.join("\n"), /FAIL: the pass rate dropped/);
  const noisy = gateCompare(mkRows("full", (t) => t !== "t1"), base, { tol: 0.05 }); assert.equal(noisy[0].ok, true); assert.match(noisy[0].lines.join("\n"), /warning: the pass rate is lower/);
  const cost = gateCompare(mkRows("full", () => true, 1400), base, { costPct: 25 }); assert.equal(cost[0].ok, false); assert.match(cost[0].lines.join("\n"), /FAIL: cost per solved task grew by more than 25%/);
  assert.equal(gateCompare(mkRows("new-variant", () => true), base)[0].ok, true);
  assert.equal(gateCompare(mkRows("full", () => true, 1100), base)[0].ok, true);
});

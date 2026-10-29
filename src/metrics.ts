// Ready-made custom metrics for `amness eval --metrics ...`. Each one is a number per run; the report shows its mean per variant and the paired difference against the baseline.
// Write your own the same way (a function in a plugin's `metrics`): anything you can compute from the finished workspace, the run's outcome or its trace.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MetricFn } from "./evals.ts";

const IGNORE = new Set([".git", "node_modules", ".amness"]);
function walk(dir: string, rel = ""): string[] {
  let out: string[] = []; try { for (const e of readdirSync(join(dir, rel)).sort()) { if (IGNORE.has(e)) continue; const r = rel ? `${rel}/${e}` : e; (statSync(join(dir, r)).isDirectory() ? out.push(...walk(dir, r)) : out.push(r)); } } catch { /* unreadable */ }
  return out;
}
const lineCounts = (text: string) => { const m = new Map<string, number>(); for (const l of text.split("\n")) m.set(l, (m.get(l) ?? 0) + 1); return m; };

export const BUILTIN_METRICS: Record<string, MetricFn> = {
  /** lines added or removed compared with the task's starting files (a smaller change that still passes is usually better) */
  "diff-lines": ({ case: c, dir }) => {
    let n = 0; const files = new Set([...Object.keys(c.files), ...walk(dir)]);
    for (const f of files) {
      const before = lineCounts(c.files[f] ?? ""), after = lineCounts(existsSync(join(dir, f)) && statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f), "utf8") : "");
      for (const [l, k] of after) n += Math.max(0, k - (before.get(l) ?? 0)); for (const [l, k] of before) n += Math.max(0, k - (after.get(l) ?? 0));
    }
    return n;
  },
  /** tool calls the agent made */
  "tool-calls": ({ outcome }) => outcome.events?.tool ?? 0,
  /** tokens spent per step: how heavy each turn was */
  "tokens-per-step": ({ outcome }) => (outcome.steps ? outcome.tokens / outcome.steps : 0),
  /** 1 when the agent's own text claims it ran tests but the check failed: a cheap overclaim detector */
  overclaim: ({ row, outcome }) => (!row.pass && /\b(tests?|build) (pass|passed|passes|succeed)/i.test(outcome.text) ? 1 : 0),
};
export const metricNamesList = () => Object.keys(BUILTIN_METRICS);

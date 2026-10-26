import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodeAgent, runShell } from "./code.ts";
import { Budget, type Model } from "./harness.ts";

export type Case = {
  name: string;
  /** Fixture files written into a fresh temp dir. */
  files: Record<string, string>;
  task: string;
  /** Shown to the agent: a command it may run to check its work (and the `finish` gate in the full variant). */
  verify?: string;
  /** Held-out judge: shell command (exit 0 = pass) or function. The agent never sees this. */
  check: string | ((dir: string) => boolean | string | Promise<boolean | string>);
};
export type Outcome = { text: string; steps: number; tokens: number };
export type Variant = { name: string; run: (c: Case, dir: string) => Promise<Outcome> };
export type Row = { case: string; variant: string; trial: number; pass: boolean; steps: number; tokens: number; ms: number; note?: string };

export async function evaluate(cases: Case[], variants: Variant[], o: { trials?: number; onRow?: (r: Row) => void } = {}) {
  const rows: Row[] = [];
  for (const c of cases) for (const v of variants) for (let trial = 0; trial < (o.trials ?? 1); trial++) {
    const dir = mkdtempSync(join(tmpdir(), "amness-eval-"));
    for (const [f, content] of Object.entries(c.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), content); }
    const t0 = Date.now();
    const row: Row = { case: c.name, variant: v.name, trial, pass: false, steps: 0, tokens: 0, ms: 0 };
    try {
      const out = await v.run(c, dir);
      Object.assign(row, { steps: out.steps, tokens: out.tokens });
      const j = typeof c.check === "string" ? ((await runShell(c.check, dir, 120_000)).startsWith("exit=0") || "check command failed") : await c.check(dir);
      row.pass = j === true; if (j !== true) row.note = String(j || "failed");
    } catch (e) { row.note = "crashed: " + (e as Error).message; }
    row.ms = Date.now() - t0;
    rows.push(row); o.onRow?.(row);
    rmSync(dir, { recursive: true, force: true });
  }
  const summary = variants.map((v) => {
    const r = rows.filter((x) => x.variant === v.name), avg = (f: (x: Row) => number) => Math.round(r.reduce((n, x) => n + f(x), 0) / (r.length || 1));
    return { variant: v.name, runs: r.length, passRate: r.filter((x) => x.pass).length / (r.length || 1), steps: avg((x) => x.steps), tokens: avg((x) => x.tokens), secs: avg((x) => x.ms) / 1000 };
  });
  return { rows, summary, table: formatTable(summary) };
}

export function formatTable(s: { variant: string; runs: number; passRate: number; steps: number; tokens: number; secs: number }[]) {
  const line = (a: (string | number)[]) => a.map((x, i) => String(x).padEnd([22, 6, 9, 7, 9, 7][i])).join(" ");
  return [line(["variant", "runs", "pass", "steps", "tokens", "secs"]), ...s.map((x) => line([x.variant, x.runs, (x.passRate * 100).toFixed(0) + "%", x.steps, x.tokens, x.secs.toFixed(1)]))].join("\n");
}

/** Ready-made A/B for coding agents: `baseline` (no guards, no verify gate) vs `full` (all guards + the case's verify command). */
export function codeVariants(model: Model, o: { maxSteps?: number; maxTokens?: number } = {}): Variant[] {
  const mk = (name: string, full: boolean): Variant => ({
    name,
    async run(c, dir) {
      const budget = new Budget({ maxTokens: o.maxTokens ?? 400_000 });
      const r = await createCodeAgent({
        model, cwd: dir, budget, maxSteps: o.maxSteps ?? 30,
        verify: full ? c.verify : undefined, off: full ? [] : ["nudge", "loop", "compact"],
      }).run(c.task);
      return { text: r.text, steps: r.steps, tokens: budget.tokens };
    },
  });
  return [mk("baseline", false), mk("full-harness", true)];
}

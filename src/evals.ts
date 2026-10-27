import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodeAgent, runShell } from "./code.ts";
import { Budget, type Event, type Guard, type Model } from "./harness.ts";
import { bootstrap, holm, mean, minDetectable, passPowK, signTest, type Interval } from "./stats.ts";

export type Case = {
  name: string;
  /** Fixture files written into a fresh temp dir. */
  files: Record<string, string>;
  task: string;
  /** Shown to the agent: a command it may run to check its work (and the `finish` gate in the full variant). */
  verify?: string;
  /** Held-out judge: shell command (exit 0 = pass) or function. The agent never sees this. */
  check: string | ((dir: string) => boolean | string | Promise<boolean | string>);
  /** A known-good fix (files to overwrite). Used by `selfTest` to prove the case is solvable and its check is not trivially true. */
  solution?: Record<string, string>;
};
export type Outcome = { text: string; steps: number; tokens: number; /** prompt tokens sent, and how many of them the provider served from its cache */ prompt?: number; cached?: number; /** how often each harness event fired during the run (nudge, loop, repair, rejected, trim, ...) */ events?: Record<string, number> };
export type Variant = { name: string; run: (c: Case, dir: string) => Promise<Outcome> };
export type Row = { case: string; variant: string; trial: number; pass: boolean; steps: number; tokens: number; ms: number; note?: string; events?: Record<string, number>; prompt?: number; cached?: number };

/** Run every case x variant x trial in a fresh temp workspace and judge each result with the case's held-out check. `jobs` runs that many sessions at once. */
export async function evaluate(cases: Case[], variants: Variant[], o: { trials?: number; jobs?: number; onRow?: (r: Row) => void; baseline?: string; k?: number } = {}) {
  const rows: Row[] = [], work: (() => Promise<void>)[] = [];
  for (const c of cases) for (const v of variants) for (let trial = 0; trial < (o.trials ?? 1); trial++) work.push(async () => {
    const dir = mkdtempSync(join(tmpdir(), "amness-eval-"));
    for (const [f, content] of Object.entries(c.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), content); }
    const t0 = Date.now();
    const row: Row = { case: c.name, variant: v.name, trial, pass: false, steps: 0, tokens: 0, ms: 0 };
    try {
      const out = await v.run(c, dir);
      Object.assign(row, { steps: out.steps, tokens: out.tokens, events: out.events, prompt: out.prompt, cached: out.cached });
      const j = typeof c.check === "string" ? ((await runShell(c.check, dir, 120_000)).startsWith("exit=0") || "check command failed") : await c.check(dir);
      row.pass = j === true; if (j !== true) row.note = String(j || "failed");
    } catch (e) { row.note = "crashed: " + (e as Error).message; }
    row.ms = Date.now() - t0;
    rows.push(row); o.onRow?.(row);
    rmSync(dir, { recursive: true, force: true });
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.jobs ?? 1, work.length)) }, async () => { while (next < work.length) await work[next++](); }));
  rows.sort((a, b) => cases.findIndex((c) => c.name === a.case) - cases.findIndex((c) => c.name === b.case) || variants.findIndex((v) => v.name === a.variant) - variants.findIndex((v) => v.name === b.variant) || a.trial - b.trial);
  const summary = variants.map((v) => {
    const r = rows.filter((x) => x.variant === v.name), avg = (f: (x: Row) => number) => Math.round(r.reduce((n, x) => n + f(x), 0) / (r.length || 1));
    return { variant: v.name, runs: r.length, passRate: r.filter((x) => x.pass).length / (r.length || 1), steps: avg((x) => x.steps), tokens: avg((x) => x.tokens), secs: avg((x) => x.ms) / 1000 };
  });
  return { rows, summary, table: formatTable(summary), analysis: analyze(rows, { baseline: o.baseline, k: o.k }) };
}

export function formatTable(s: { variant: string; runs: number; passRate: number; steps: number; tokens: number; secs: number }[]) {
  const line = (a: (string | number)[]) => a.map((x, i) => String(x).padEnd([22, 6, 9, 7, 9, 7][i])).join(" ");
  return [line(["variant", "runs", "pass", "steps", "tokens", "secs"]), ...s.map((x) => line([x.variant, x.runs, (x.passRate * 100).toFixed(0) + "%", x.steps, x.tokens, x.secs.toFixed(1)]))].join("\n");
}

// ------------------------------------------------------------------------------------------------------------------ analysis
export type VariantStats = {
  variant: string; tasks: number; runs: number; trials: number;
  passRate: number; ci: Interval; /** reliability: chance that k independent attempts at a task all pass */ passPowK: number; k: number;
  tokensPerSolved: number; /** share of prompt tokens served from the provider cache (NaN when the provider reports none) */ cacheHit: number; steps: number; secs: number; events: Record<string, number>; /** not beaten on both pass rate and cost by another variant */ pareto: boolean;
};
export type Comparison = {
  variant: string; vs: string; dPass: number; ci: Interval; wins: number; losses: number; ties: number; p: number; pAdj: number;
  dTokensPerSolved: number; verdict: "better" | "worse" | "inconclusive";
};
export type Analysis = { baseline: string; tasks: number; trials: number; stats: VariantStats[]; comparisons: Comparison[]; minDetectable: number };

/**
 * Turn raw rows into a statistical comparison. Tasks are the unit: each task contributes its pass fraction across trials, intervals are
 * task-level bootstrap intervals, the significance test is an exact sign test on the tasks where two variants differ, and p-values are
 * Holm-adjusted across the variants compared. Cost is reported as tokens per solved task, not per run, so a cheap variant that fails is not "efficient".
 */
export function analyze(rows: Row[], o: { baseline?: string; k?: number; seed?: number } = {}): Analysis {
  const variants = [...new Set(rows.map((r) => r.variant))], tasks = [...new Set(rows.map((r) => r.case))];
  const trials = Math.max(1, ...rows.map((r) => r.trial + 1)), k = Math.min(o.k ?? 3, trials) || 1, baseline = o.baseline && variants.includes(o.baseline) ? o.baseline : variants[0];
  type T = { n: number; pass: number; tokens: number };
  const cell = new Map<string, T>();
  for (const r of rows) { const key = r.variant + "\0" + r.case, c = cell.get(key) ?? { n: 0, pass: 0, tokens: 0 }; c.n++; c.pass += r.pass ? 1 : 0; c.tokens += r.tokens; cell.set(key, c); }
  const of = (v: string) => tasks.map((t) => cell.get(v + "\0" + t) ?? { n: 0, pass: 0, tokens: 0 });
  const frac = (xs: T[]) => mean(xs.filter((x) => x.n).map((x) => x.pass / x.n));
  const tps = (xs: T[]) => { const p = xs.reduce((n, x) => n + x.pass, 0); return p ? xs.reduce((n, x) => n + x.tokens, 0) / p : Infinity; };
  const stats: VariantStats[] = variants.map((v) => {
    const r = rows.filter((x) => x.variant === v), per = of(v), ev: Record<string, number> = {};
    for (const x of r) for (const [e, n] of Object.entries(x.events ?? {})) ev[e] = (ev[e] ?? 0) + n / r.length;
    return { variant: v, tasks: tasks.length, runs: r.length, trials, passRate: frac(per), ci: bootstrap(per, frac, { seed: o.seed }), passPowK: mean(per.filter((x) => x.n >= k).map((x) => passPowK(x.pass, x.n, k))), k,
      tokensPerSolved: tps(per), cacheHit: (() => { const p = r.reduce((n, x) => n + (x.prompt ?? 0), 0); return p ? r.reduce((n, x) => n + (x.cached ?? 0), 0) / p : NaN; })(), steps: mean(r.map((x) => x.steps)), secs: mean(r.map((x) => x.ms)) / 1000, events: ev, pareto: true };
  });
  for (const a of stats) a.pareto = !stats.some((b) => b !== a && b.passRate >= a.passRate && b.tokensPerSolved <= a.tokensPerSolved && (b.passRate > a.passRate || b.tokensPerSolved < a.tokensPerSolved));
  const base = of(baseline), raw = variants.filter((v) => v !== baseline).map((v) => {
    const cur = of(v), pairs = tasks.map((_, i) => [cur[i], base[i]] as const);
    let wins = 0, losses = 0; for (const [a, b] of pairs) { const x = a.n && b.n ? a.pass / a.n - b.pass / b.n : 0; if (x > 1e-9) wins++; else if (x < -1e-9) losses++; }
    const d = (ps: (readonly [T, T])[]) => frac(ps.map((p) => p[0])) - frac(ps.map((p) => p[1]));
    const dt = (ps: (readonly [T, T])[]) => tps(ps.map((p) => p[0])) - tps(ps.map((p) => p[1]));
    return { variant: v, vs: baseline, dPass: d([...pairs]), ci: bootstrap([...pairs], d, { seed: o.seed }), wins, losses, ties: tasks.length - wins - losses, p: signTest(wins, losses), dTokensPerSolved: dt([...pairs]) };
  });
  const adj = holm(raw.map((c) => c.p));
  const comparisons: Comparison[] = raw.map((c, i) => ({ ...c, pAdj: adj[i], verdict: c.ci.lo > 0 && adj[i] < 0.05 ? "better" : c.ci.hi < 0 && adj[i] < 0.05 ? "worse" : "inconclusive" }));
  return { baseline, tasks: tasks.length, trials, stats, comparisons, minDetectable: minDetectable(tasks.length) };
}

const pct = (x: number, d = 0) => (Number.isNaN(x) ? "-" : (x * 100).toFixed(d) + "%");
const sgn = (x: number, d = 0) => (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + " pts";
const kfmt = (n: number) => (!Number.isFinite(n) ? "n/a" : Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

/** Plain-text report: per-variant table, paired comparison against the baseline, and an honest reading of what the data can support. */
export function formatReport(a: Analysis): string {
  const pad = (x: string | number, n: number) => String(x).padEnd(n), out: string[] = [];
  out.push(`${a.tasks} tasks × ${a.trials} trial${a.trials === 1 ? "" : "s"}; intervals are 95% bootstrap over tasks; baseline = ${a.baseline}`, "");
  out.push([pad("variant", 22), pad("pass [95% CI]", 20), pad(`pass^${a.stats[0]?.k ?? 1}`, 7), pad("tok/solved", 11), pad("cache", 6), pad("steps", 6), pad("secs", 6), "pareto"].join(" "));
  for (const s of a.stats) out.push([pad(s.variant, 22), pad(`${pct(s.passRate)} [${pct(s.ci.lo)}-${pct(s.ci.hi)}]`, 20), pad(pct(s.passPowK), 7), pad(kfmt(s.tokensPerSolved), 11), pad(pct(s.cacheHit), 6), pad(s.steps.toFixed(1), 6), pad(s.secs.toFixed(1), 6), s.pareto ? "●" : ""].join(" "));
  if (a.comparisons.length) {
    out.push("", `vs ${a.baseline} (paired by task)`, [pad("variant", 22), pad("Δ pass [95% CI]", 26), pad("W/L/T", 9), pad("p (Holm)", 9), pad("Δ tok/solved", 13), "verdict"].join(" "));
    for (const c of a.comparisons) out.push([pad(c.variant, 22), pad(`${sgn(c.dPass)} [${sgn(c.ci.lo)}, ${sgn(c.ci.hi)}]`, 26), pad(`${c.wins}/${c.losses}/${c.ties}`, 9), pad(c.pAdj.toFixed(3), 9), pad((c.dTokensPerSolved >= 0 ? "+" : "") + kfmt(c.dTokensPerSolved), 13), c.verdict].join(" "));
  }
  const fired = a.stats.filter((s) => Object.keys(s.events).length);
  if (fired.length) { out.push("", "guards fired per run:"); for (const s of fired) out.push(`  ${pad(s.variant, 22)} ${Object.entries(s.events).filter(([, n]) => n >= 0.01).map(([k, n]) => `${k} ${n.toFixed(2)}`).join(" · ")}`); }
  out.push("", `reading: with ${a.tasks} task${a.tasks === 1 ? "" : "s"} only pass-rate differences above ~${(a.minDetectable * 100).toFixed(0)} points can be detected reliably; "inconclusive" means the data cannot tell, not that the variants are equal.`);
  if (a.trials < 3) out.push(`         ${a.trials} trial${a.trials === 1 ? "" : "s"} per task: model sampling noise is not averaged out; use --trials 3 or more for decisions.`);
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------------------------ variants
const ALL_GUARDS: Guard[] = ["nudge", "loop", "compact", "stuck", "wrapup", "condense", "schedule", "ledger", "stagnation"];
/** Features that are not loop guards but can be switched off the same way for ablations. */
const FEATURES = ["index"] as const;
export const VARIANT_HELP = "baseline (no guards, no gate) · full (all guards + verify gate) · full+check (adds a post-edit check) · full+review (adds the independent reviewer) · no-gate (guards, no verify gate) · full-<guard> to switch one guard or feature off: " + [...ALL_GUARDS, ...FEATURES].join(", ");

/** Build a named variant of the code agent. Names: see VARIANT_HELP. */
export function harnessVariant(model: Model, name: string, o: { maxSteps?: number; maxTokens?: number } = {}): Variant {
  const m = /^full-(.+)$/.exec(name), droppedRaw = m ? m[1] : undefined, dropped = droppedRaw && ALL_GUARDS.includes(droppedRaw as Guard) ? (droppedRaw as Guard) : undefined, feature = droppedRaw && (FEATURES as readonly string[]).includes(droppedRaw) ? droppedRaw : undefined;
  if (droppedRaw && !dropped && !feature) throw new Error(`unknown guard "${droppedRaw}" in variant "${name}". Guards: ${[...ALL_GUARDS, ...FEATURES].join(", ")}`);
  if (!droppedRaw && !["baseline", "full", "full+check", "full+review", "no-gate"].includes(name)) throw new Error(`unknown variant "${name}". Known: ${VARIANT_HELP}`);
  return {
    name,
    async run(c, dir) {
      const budget = new Budget({ maxTokens: o.maxTokens ?? 400_000 }), events: Record<string, number> = {};
      const off = name === "baseline" ? ALL_GUARDS : dropped ? [dropped] : [];
      const r = await createCodeAgent({
        model, cwd: dir, budget, maxSteps: o.maxSteps ?? 30, off, memory: false, index: name === "baseline" || feature === "index" ? false : undefined,
        verify: name === "baseline" || name === "no-gate" ? undefined : c.verify, check: name === "full+check" ? c.verify : undefined, review: name === "full+review" || undefined,
        onEvent: (e: Event) => { if (e.kind !== "text" && e.kind !== "thinking" && e.kind !== "assistant" && e.kind !== "toolstart" && e.kind !== "phase") events[e.kind] = (events[e.kind] ?? 0) + 1; },
      }).run(c.task);
      return { text: r.text, steps: r.steps, tokens: budget.tokens, events, prompt: budget.promptTokens, cached: budget.cachedTokens };
    },
  };
}

/** Ready-made A/B for coding agents: `baseline` (no guards, no verify gate) vs `full-harness` (all guards + the case's verify command). */
export function codeVariants(model: Model, o: { maxSteps?: number; maxTokens?: number } = {}): Variant[] {
  return [{ ...harnessVariant(model, "baseline", o), name: "baseline" }, { ...harnessVariant(model, "full", o), name: "full-harness" }];
}
/** Expand a preset or comma list into variant names: `ab`, `ablate` (full plus each guard removed in turn), `all`. */
export function variantNames(spec: string): string[] {
  const out: string[] = [];
  for (const p of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (p === "ab") out.push("baseline", "full");
    else if (p === "ablate") out.push("full", ...[...ALL_GUARDS, ...FEATURES].map((g) => `full-${g}`));
    else if (p === "all") out.push("baseline", "no-gate", "full", "full+check", "full+review", ...[...ALL_GUARDS, ...FEATURES].map((g) => `full-${g}`));
    else out.push(p);
  }
  return [...new Set(out)];
}

/** Prove each case is sound: its check must FAIL on the starting files and PASS once the reference solution is applied. */
export async function selfTest(cases: Case[]): Promise<{ case: string; ok: boolean; why?: string }[]> {
  const out: { case: string; ok: boolean; why?: string }[] = [];
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), "amness-self-"));
    try {
      for (const [f, t] of Object.entries(c.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
      const judge = async () => (typeof c.check === "string" ? (await runShell(c.check, dir, 60_000)).startsWith("exit=0") : (await c.check(dir)) === true);
      if (await judge()) { out.push({ case: c.name, ok: false, why: "check already passes before any fix" }); continue; }
      if (!c.solution) { out.push({ case: c.name, ok: true, why: "unverified: no reference solution, only checked that the check fails on the starting files" }); continue; }
      for (const [f, t] of Object.entries(c.solution)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
      out.push((await judge()) ? { case: c.name, ok: true } : { case: c.name, ok: false, why: "check still fails with the reference solution" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

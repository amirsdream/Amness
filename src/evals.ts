import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodeAgent, runShell } from "./code.ts";
import { routedModel } from "./router.ts";
import { Budget, type Event, type Guard, type Model, type Tool } from "./harness.ts";
import type { Profile } from "./profiles.ts";
import type { Plugin, VariantSpec } from "./plugins.ts";
import { STRATEGIES } from "./strategies.ts";
import { CHAOS_KINDS, chaosModel, chaosTools } from "./chaos.ts";
import { promptPlugin } from "./prompts.ts";
import { Gate, rateLimited } from "./ratelimit.ts";
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
  /** Extra tools for this case (a stubbed web page, a fake MCP server): the agent gets them next to its own. */
  tools?: (dir: string) => Tool[];
  /** Prepare the workspace beyond writing `files` (clone a repository, check out a commit, apply a patch). A failure excludes the case from the statistics instead of counting as a fail. */
  setup?: (dir: string) => Promise<void>;
};
export type Outcome = { text: string; steps: number; tokens: number; /** prompt tokens sent, and how many of them the provider served from its cache */ prompt?: number; cached?: number; /** how often each harness event fired during the run (nudge, loop, repair, rejected, trim, ...) */ events?: Record<string, number> };
/** A number computed for every run, beyond pass/fail (cost, diff size, tool calls, anything): the report shows its mean per variant and the paired difference against the baseline. */
export type MetricFn = (ctx: { case: Case; row: Row; outcome: Outcome; dir: string }) => number | Promise<number>;
export type Variant = { name: string; run: (c: Case, dir: string) => Promise<Outcome> };
export type Row = { /** set when the workspace could not be prepared: the run is listed in the exclusion ledger and left out of every statistic */ excluded?: string; case: string; variant: string; trial: number; pass: boolean; steps: number; tokens: number; ms: number; note?: string; /** values of the custom metrics for this run */ metrics?: Record<string, number>; events?: Record<string, number>; prompt?: number; cached?: number };

/** Run every case x variant x trial in a fresh temp workspace and judge each result with the case's held-out check. `jobs` runs that many sessions at once. */
export async function evaluate(cases: Case[], variants: Variant[], o: { metrics?: Record<string, MetricFn>; trials?: number; jobs?: number; onRow?: (r: Row) => void; baseline?: string; k?: number; seed?: number } = {}) {
  const rows: Row[] = [], work: (() => Promise<void>)[] = [];
  for (const c of cases) for (const v of variants) for (let trial = 0; trial < (o.trials ?? 1); trial++) work.push(async () => {
    const dir = mkdtempSync(join(tmpdir(), "amness-eval-"));
    for (const [f, content] of Object.entries(c.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), content); }
    const t0 = Date.now();
    const row: Row = { case: c.name, variant: v.name, trial, pass: false, steps: 0, tokens: 0, ms: 0 };
    if (c.setup) { try { await c.setup(dir); } catch (e) { row.excluded = (e as Error).message.slice(0, 300); row.ms = Date.now() - t0; rows.push(row); o.onRow?.(row); rmSync(dir, { recursive: true, force: true }); return; } }
    try {
      const out = await v.run(c, dir);
      Object.assign(row, { steps: out.steps, tokens: out.tokens, events: out.events, prompt: out.prompt, cached: out.cached });
      const j = typeof c.check === "string" ? ((await runShell(c.check, dir, 120_000)).startsWith("exit=0") || "check command failed") : await c.check(dir);
      row.pass = j === true; if (j !== true) row.note = String(j || "failed");
      if (o.metrics) { row.metrics = {}; for (const [name, fn] of Object.entries(o.metrics)) { try { const v = await fn({ case: c, row, outcome: out, dir }); if (Number.isFinite(v)) row.metrics[name] = v; } catch { /* a broken metric must not fail the run */ } } }
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
  return { rows, summary, table: formatTable(summary), analysis: analyze(rows, { baseline: o.baseline, k: o.k, seed: o.seed }) };
}

export function formatTable(s: { variant: string; runs: number; passRate: number; steps: number; tokens: number; secs: number }[]) {
  const line = (a: (string | number)[]) => a.map((x, i) => String(x).padEnd([22, 6, 9, 7, 9, 7][i])).join(" ");
  return [line(["variant", "runs", "pass", "steps", "tokens", "secs"]), ...s.map((x) => line([x.variant, x.runs, (x.passRate * 100).toFixed(0) + "%", x.steps, x.tokens, x.secs.toFixed(1)]))].join("\n");
}

// ------------------------------------------------------------------------------------------------------------------ analysis
export type VariantStats = {
  variant: string; tasks: number; runs: number; trials: number;
  passRate: number; ci: Interval; /** reliability: chance that k independent attempts at a task all pass */ passPowK: number; k: number;
  /** mean of each custom metric (per-task means, then the mean over tasks) */ metrics: Record<string, number>;
  tokensPerSolved: number; /** share of prompt tokens served from the provider cache (NaN when the provider reports none) */ cacheHit: number; steps: number; secs: number; events: Record<string, number>; /** not beaten on both pass rate and cost by another variant */ pareto: boolean;
};
export type Comparison = {
  variant: string; vs: string; dPass: number; ci: Interval; wins: number; losses: number; ties: number; p: number; pAdj: number;
  dTokensPerSolved: number; verdict: "better" | "worse" | "inconclusive";
  /** paired difference of each custom metric against the baseline, with a 95% interval over tasks */ metrics: Record<string, { d: number; ci: Interval }>;
};
export type Analysis = { /** runs left out because the workspace could not be prepared, with the reason */ excluded: { case: string; variant: string; reason: string }[]; baseline: string; tasks: number; trials: number; stats: VariantStats[]; comparisons: Comparison[]; metricNames: string[]; minDetectable: number };

/**
 * Turn raw rows into a statistical comparison. Tasks are the unit: each task contributes its pass fraction across trials, intervals are
 * task-level bootstrap intervals, the significance test is an exact sign test on the tasks where two variants differ, and p-values are
 * Holm-adjusted across the variants compared. Cost is reported as tokens per solved task, not per run, so a cheap variant that fails is not "efficient".
 */
export function analyze(allRows: Row[], o: { baseline?: string; k?: number; seed?: number } = {}): Analysis {
  const rows = allRows.filter((r) => !r.excluded), excluded = allRows.filter((r) => r.excluded);
  const variants = [...new Set(rows.map((r) => r.variant))], tasks = [...new Set(rows.map((r) => r.case))];
  const trials = Math.max(1, ...rows.map((r) => r.trial + 1)), k = Math.min(o.k ?? 3, trials) || 1, baseline = o.baseline && variants.includes(o.baseline) ? o.baseline : variants[0];
  type T = { n: number; pass: number; tokens: number };
  const cell = new Map<string, T>();
  for (const r of rows) { const key = r.variant + "\0" + r.case, c = cell.get(key) ?? { n: 0, pass: 0, tokens: 0 }; c.n++; c.pass += r.pass ? 1 : 0; c.tokens += r.tokens; cell.set(key, c); }
  const of = (v: string) => tasks.map((t) => cell.get(v + "\0" + t) ?? { n: 0, pass: 0, tokens: 0 });
  const frac = (xs: T[]) => mean(xs.filter((x) => x.n).map((x) => x.pass / x.n));
  const tps = (xs: T[]) => { const p = xs.reduce((n, x) => n + x.pass, 0); return p ? xs.reduce((n, x) => n + x.tokens, 0) / p : Infinity; };
  const metricNames = [...new Set(rows.flatMap((r) => Object.keys(r.metrics ?? {})))];
  const perTask = (v: string, m: string) => tasks.map((t) => { const xs = rows.filter((r) => r.variant === v && r.case === t && r.metrics?.[m] !== undefined).map((r) => r.metrics![m]); return xs.length ? mean(xs) : NaN; });
  const stats: VariantStats[] = variants.map((v) => {
    const r = rows.filter((x) => x.variant === v), per = of(v), ev: Record<string, number> = {};
    for (const x of r) for (const [e, n] of Object.entries(x.events ?? {})) ev[e] = (ev[e] ?? 0) + n / r.length;
    return { variant: v, tasks: tasks.length, runs: r.length, trials, passRate: frac(per), ci: bootstrap(per, frac, { seed: o.seed }), passPowK: mean(per.filter((x) => x.n >= k).map((x) => passPowK(x.pass, x.n, k))), k, metrics: Object.fromEntries(metricNames.map((m) => [m, mean(perTask(v, m).filter((x) => !Number.isNaN(x)))])),
      tokensPerSolved: tps(per), cacheHit: (() => { const p = r.reduce((n, x) => n + (x.prompt ?? 0), 0); return p ? r.reduce((n, x) => n + (x.cached ?? 0), 0) / p : NaN; })(), steps: mean(r.map((x) => x.steps)), secs: mean(r.map((x) => x.ms)) / 1000, events: ev, pareto: true };
  });
  for (const a of stats) a.pareto = !stats.some((b) => b !== a && b.passRate >= a.passRate && b.tokensPerSolved <= a.tokensPerSolved && (b.passRate > a.passRate || b.tokensPerSolved < a.tokensPerSolved));
  const base = of(baseline), raw = variants.filter((v) => v !== baseline).map((v) => {
    const cur = of(v), pairs = tasks.map((_, i) => [cur[i], base[i]] as const);
    let wins = 0, losses = 0; for (const [a, b] of pairs) { const x = a.n && b.n ? a.pass / a.n - b.pass / b.n : 0; if (x > 1e-9) wins++; else if (x < -1e-9) losses++; }
    const d = (ps: (readonly [T, T])[]) => frac(ps.map((p) => p[0])) - frac(ps.map((p) => p[1]));
    const dt = (ps: (readonly [T, T])[]) => tps(ps.map((p) => p[0])) - tps(ps.map((p) => p[1]));
    return { variant: v, vs: baseline, dPass: d([...pairs]), ci: bootstrap([...pairs], d, { seed: o.seed }), wins, losses, ties: tasks.length - wins - losses, p: signTest(wins, losses), dTokensPerSolved: dt([...pairs]),
      metrics: Object.fromEntries(metricNames.map((m) => { const a = perTask(v, m), b = perTask(baseline, m), idx = tasks.map((_, i) => i).filter((i) => !Number.isNaN(a[i]) && !Number.isNaN(b[i])); const dm = (is: number[]) => mean(is.map((i) => a[i] - b[i])); return [m, { d: dm(idx), ci: bootstrap(idx, dm, { seed: o.seed }) }]; })) };
  });
  const adj = holm(raw.map((c) => c.p));
  const comparisons: Comparison[] = raw.map((c, i) => ({ ...c, pAdj: adj[i], verdict: c.ci.lo > 0 && adj[i] < 0.05 ? "better" : c.ci.hi < 0 && adj[i] < 0.05 ? "worse" : "inconclusive" }));
  return { excluded: excluded.map((r) => ({ case: r.case, variant: r.variant, reason: r.excluded! })), baseline, tasks: tasks.length, trials, stats, comparisons, metricNames, minDetectable: minDetectable(tasks.length) };
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
  if (a.metricNames.length) {
    const f = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "n/a");
    out.push("", "custom metrics (mean per run; Δ against " + a.baseline + " with 95% interval over tasks)", [pad("variant", 22), ...a.metricNames.map((m) => pad(m, 30))].join(" "));
    for (const s of a.stats) { const c = a.comparisons.find((x) => x.variant === s.variant); out.push([pad(s.variant, 22), ...a.metricNames.map((m) => pad(f(s.metrics[m]) + (c ? `  Δ ${c.metrics[m].d >= 0 ? "+" : ""}${f(c.metrics[m].d)} [${f(c.metrics[m].ci.lo)}, ${f(c.metrics[m].ci.hi)}]` : ""), 30))].join(" ")); }
  }
  const fired = a.stats.filter((s) => Object.keys(s.events).length);
  if (fired.length) { out.push("", "guards fired per run:"); for (const s of fired) out.push(`  ${pad(s.variant, 22)} ${Object.entries(s.events).filter(([, n]) => n >= 0.01).map(([k, n]) => `${k} ${n.toFixed(2)}`).join(" · ")}`); }
  if (a.excluded.length) { out.push("", `exclusion ledger: ${a.excluded.length} run(s) could not be set up and are NOT counted anywhere above:`); for (const x of a.excluded.slice(0, 10)) out.push(`  ${x.case} / ${x.variant}: ${x.reason}`); }
  out.push("", `reading: with ${a.tasks} task${a.tasks === 1 ? "" : "s"} only pass-rate differences above ~${(a.minDetectable * 100).toFixed(0)} points can be detected reliably; "inconclusive" means the data cannot tell, not that the variants are equal.`);
  if (a.trials < 3) out.push(`         ${a.trials} trial${a.trials === 1 ? "" : "s"} per task: model sampling noise is not averaged out; use --trials 3 or more for decisions.`);
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------------------------ variants
const ALL_GUARDS: Guard[] = ["nudge", "loop", "compact", "stuck", "wrapup", "condense", "schedule", "ledger", "stagnation"];
/** Features that are not loop guards but can be switched off the same way for ablations. */
const FEATURES = ["index", "taint"] as const;
export const VARIANT_HELP = "baseline (no guards, no gate) · full (all guards + verify gate) · full+check (adds a post-edit check) · full+review (adds the independent reviewer) · full+route (exploration on a cheaper model, needs --cheap-model) · full+plugins (every loaded plugin active, needs --plugin) · prompt:<id> (a system prompt from .amness/prompts) · model:<id> (the full harness on another model) · chaos:tools|429|args|slow-tools (the full harness while things break on purpose) · strategy:<name> (the full harness with a loop strategy: plan-first, explore-then-act) · any variant a plugin defines · no-gate (guards, no verify gate) · full-<guard> to switch one guard or feature off: " + [...ALL_GUARDS, ...FEATURES].join(", ");

/** Build a named variant of the code agent. Names: see VARIANT_HELP. */
/** A plugin-defined variant: the plugin's variants are looked up by `name` or `plugin:name`. */
export function findPluginVariant(plugins: Plugin[] | undefined, name: string): { spec: VariantSpec; owner: Plugin } | undefined {
  for (const p of plugins ?? []) for (const [k, spec] of Object.entries(p.variants ?? {})) if (name === k || name === `${p.name}:${k}`) return { spec, owner: p };
  return undefined;
}
function pluginVariant(model: Model, name: string, found: { spec: VariantSpec; owner: Plugin }, o: { maxSteps?: number; maxTokens?: number; plugins?: Plugin[] }): Variant {
  const { spec, owner } = found;
  if (spec.build) return { name, run: (c, dir) => spec.build!(model, { maxSteps: o.maxSteps, maxTokens: o.maxTokens }).run(c, dir) };
  const active = [owner, ...(spec.plugins ?? []).map((n) => (o.plugins ?? []).find((p) => p.name === n)).filter((p): p is Plugin => !!p && p !== owner)];
  if (spec.system) active.push({ name: `${owner.name}-variant-system`, system: spec.system });
  return {
    name,
    async run(c, dir) {
      const budget = new Budget({ maxTokens: o.maxTokens ?? 400_000 }), events: Record<string, number> = {};
      const r = await createCodeAgent({
        model, cwd: dir, budget, maxSteps: spec.maxSteps ?? o.maxSteps ?? 30, off: spec.off ?? [], memory: false, plugins: active, tools: c.tools?.(dir),
        verify: spec.verify === false ? undefined : c.verify, review: spec.review || undefined,
        onEvent: (e: Event) => { if (e.kind !== "text" && e.kind !== "thinking" && e.kind !== "assistant" && e.kind !== "toolstart" && e.kind !== "phase") events[e.kind] = (events[e.kind] ?? 0) + 1; },
      }).run(c.task);
      return { text: r.text, steps: r.steps, tokens: budget.tokens, events, prompt: budget.promptTokens, cached: budget.cachedTokens };
    },
  };
}

export function harnessVariant(model: Model, name: string, o: { maxSteps?: number; maxTokens?: number; /** the cheaper model for the `full+route` variant */ cheap?: Model; /** models by id, for `model:<id>` variants */ modelFor?: (id: string) => Model; wrapTools?: (tools: Tool[]) => Tool[]; /** harness settings to run under (used by `amness tune`) */ profile?: Profile; /** loaded plugins: a variant name may refer to one of their `variants` (as `name` or `plugin:name`) */ plugins?: Plugin[]; prices?: { strong: { input: number; output: number }; cheap: { input: number; output: number } } } = {}): Variant {
  const fromPlugin = findPluginVariant(o.plugins, name); if (fromPlugin) return pluginVariant(model, name, fromPlugin, o);
  const mid = /^model:(.+)$/.exec(name)?.[1]; if (mid) { if (!o.modelFor) throw new Error(`variant ${name} needs models by id (use amness eval, or pass modelFor)`); return { ...harnessVariant(o.modelFor(mid), "full", { ...o, modelFor: undefined }), name }; }
  const pid = /^prompt:(.+)$/.exec(name)?.[1]; if (pid) return pluginVariant(model, name, { spec: { verify: true }, owner: promptPlugin(process.cwd(), pid) }, o);
  const chaos = /^chaos:(.+)$/.exec(name)?.[1] as (typeof CHAOS_KINDS)[number] | undefined;
  if (chaos) {
    if (!CHAOS_KINDS.includes(chaos)) throw new Error(`unknown chaos kind "${chaos}". Known: ${CHAOS_KINDS.join(", ")}`);
    const m = chaos === "429" || chaos === "args" ? (chaos === "429" ? rateLimited(chaosModel(model, { kind: "429" }), { gate: new Gate(), retries: 8 }) : chaosModel(model, { kind: "args" })) : model;
    return { ...harnessVariant(m, "full", { ...o, wrapTools: chaos === "tools" ? (ts) => chaosTools(ts, { rate: 0.25 }) : chaos === "slow-tools" ? (ts) => chaosTools(ts, { rate: 0, delayMs: 400 }) : undefined }), name };
  }
  const strat = /^strategy:(.+)$/.exec(name)?.[1]; if (strat) { if (!STRATEGIES[strat]) throw new Error(`unknown strategy "${strat}". Known: ${Object.keys(STRATEGIES).join(", ")}`); return pluginVariant(model, name, { spec: { verify: true }, owner: STRATEGIES[strat]() }, o); }
  const m = /^full-(.+)$/.exec(name), droppedRaw = m ? m[1] : undefined, dropped = droppedRaw && ALL_GUARDS.includes(droppedRaw as Guard) ? (droppedRaw as Guard) : undefined, feature = droppedRaw && (FEATURES as readonly string[]).includes(droppedRaw) ? droppedRaw : undefined;
  if (droppedRaw && !dropped && !feature) throw new Error(`unknown guard "${droppedRaw}" in variant "${name}". Guards: ${[...ALL_GUARDS, ...FEATURES].join(", ")}`);
  if (!droppedRaw && !["baseline", "full", "full+check", "full+review", "full+route", "full+plugins", "no-gate"].includes(name)) throw new Error(`unknown variant "${name}". Known: ${VARIANT_HELP}`);
  return {
    name,
    async run(c, dir) {
      const budget = new Budget({ maxTokens: o.maxTokens ?? 400_000 }), events: Record<string, number> = {};
      const off = name === "baseline" ? ALL_GUARDS : [...(dropped ? [dropped] : []), ...(o.profile?.off ?? [])];
      if (name === "full+route" && !o.cheap) throw new Error("the full+route variant needs a cheap model: pass --cheap-model <id>");
      const r = await createCodeAgent({
        model: name === "full+route" ? routedModel({ strong: model, cheap: o.cheap!, prices: o.prices, onRoute: (d) => { events[d.switched ? `route-${d.tier}` : "route-stay"] = (events[d.switched ? `route-${d.tier}` : "route-stay"] ?? 0) + 1; } }) : model, cwd: dir, budget, maxSteps: o.profile?.maxSteps ?? o.maxSteps ?? 30, stagnationTurns: o.profile?.stagnationTurns, off, memory: false, index: name === "baseline" || feature === "index" ? false : undefined, taint: name === "baseline" || feature === "taint" ? "off" : undefined, tools: c.tools?.(dir),
        plugins: name === "full+plugins" ? o.plugins : undefined, wrapTools: o.wrapTools, verify: name === "baseline" || name === "no-gate" ? undefined : c.verify, check: name === "full+check" ? c.verify : undefined, review: name === "full+review" || undefined,
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

// ------------------------------------------------------------------------------------------------------------------ regression gate
export type GateVerdict = { variant: string; ok: boolean; lines: string[] };
/**
 * A regression gate for CI: compare a new run with a saved one, variant by variant, on the tasks both have. It fails when the pass rate dropped by more than `tol`
 * AND the drop is clear (the 95% interval over tasks is below zero), or when tokens per solved task grew by more than `costPct` percent. A drop that noise could explain is a warning, not a failure.
 */
export function gateCompare(current: Row[], baseline: Row[], o: { tol?: number; costPct?: number; seed?: number } = {}): GateVerdict[] {
  const tol = o.tol ?? 0.05, costPct = o.costPct ?? 25, ok = (r: Row) => !r.excluded, out: GateVerdict[] = [];
  for (const v of [...new Set(current.filter(ok).map((r) => r.variant))]) {
    const cur = current.filter((r) => ok(r) && r.variant === v), old = baseline.filter((r) => ok(r) && r.variant === v);
    if (!old.length) { out.push({ variant: v, ok: true, lines: ["not in the baseline file: nothing to compare"] }); continue; }
    const tasks = [...new Set(cur.map((r) => r.case))].filter((t) => old.some((r) => r.case === t));
    const frac = (rows: Row[], t: string) => { const xs = rows.filter((r) => r.case === t); return xs.length ? xs.filter((r) => r.pass).length / xs.length : NaN; };
    const idx = tasks.map((_, i) => i), a = tasks.map((t) => frac(cur, t)), b = tasks.map((t) => frac(old, t)), dm = (is: number[]) => mean(is.map((i) => a[i] - b[i]));
    const d = dm(idx), ci = bootstrap(idx, dm, { seed: o.seed }), lines: string[] = []; let pass = true;
    lines.push(`pass rate ${(mean(a) * 100).toFixed(0)}% now, ${(mean(b) * 100).toFixed(0)}% in the baseline (${d >= 0 ? "+" : ""}${(d * 100).toFixed(0)} pts, 95% interval ${(ci.lo * 100).toFixed(0)} to ${(ci.hi * 100).toFixed(0)}, ${tasks.length} common tasks)`);
    if (d < -tol && ci.hi < 0) { pass = false; lines.push(`FAIL: the pass rate dropped by more than ${(tol * 100).toFixed(0)} points and the drop is clear`); }
    else if (d < -tol) lines.push(`warning: the pass rate is lower by more than ${(tol * 100).toFixed(0)} points, but noise could explain it (interval includes zero)`);
    const tps = (rows: Row[]) => { const p = rows.filter((r) => tasks.includes(r.case) && r.pass).length; return p ? rows.filter((r) => tasks.includes(r.case)).reduce((n, r) => n + r.tokens, 0) / p : Infinity; };
    const tn = tps(cur), to = tps(old);
    if (Number.isFinite(tn) && Number.isFinite(to)) { const up = (tn / to - 1) * 100; lines.push(`tokens per solved task ${Math.round(tn)} now, ${Math.round(to)} in the baseline (${up >= 0 ? "+" : ""}${up.toFixed(0)}%)`); if (up > costPct) { pass = false; lines.push(`FAIL: cost per solved task grew by more than ${costPct}%`); } }
    out.push({ variant: v, ok: pass, lines });
  }
  return out;
}

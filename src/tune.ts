// `amness tune`: bounded self-improvement of the harness's own settings. The search space is small and fixed (switch one guard off, change a limit, require a
// tool call each step), never free-form edits, and never the safety parts: permissions, the sandbox, secret masking and the evaluators stay out of reach
// (keep evaluators outside the loop: Weng 2026; Self-Harness, arXiv 2606.09498). A change is only kept if it holds up twice: on the training tasks, and again
// on tasks the search never saw. Each change states what it is expected to do, and the log says whether that came true (AHE, arXiv 2604.25850).
// With several models, each is tuned on its own and a change goes into the profile of the models it held up for, never into a shared default it did not earn.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyze, evaluate, type Case, type Row, type Variant } from "./evals.ts";
import type { Profile } from "./profiles.ts";
import type { Guard } from "./harness.ts";
import { rng } from "./stats.ts";

export type Step = { change: string; stage: "train" | "heldout"; accepted: boolean; why: string; /** what the change was expected to do, and whether the numbers agreed */ predicted?: string; held?: boolean; model?: string };
export type TuneResult = { profile: Profile; accepted: string[]; steps: Step[]; train: string[]; heldOut: string[]; strength: string };
export type TuneOptions = {
  cases: Case[];
  /** Build a runnable variant for a profile. `amness tune` uses the real code agent; tests use a scripted one. */
  makeVariant: (profile: Profile, name: string) => Variant;
  base?: Profile; trials?: number; jobs?: number; seed?: number; heldOutFraction?: number;
  guards?: Guard[]; stagnationTurns?: number[]; /** step limits to try */ maxSteps?: number[]; /** also try requiring a tool call at every step */ toolChoice?: boolean;
  onStep?: (s: Step) => void; onRow?: (r: Row) => void;
};
/** Guards the search may switch off. Safety guards (secret masking) are never candidates. */
const NEVER: Guard[] = ["redact"];
const DEFAULT_GUARDS: Guard[] = ["nudge", "loop", "stuck", "wrapup", "condense", "stagnation", "readdelta", "toolcache", "anchor", "pin", "audit", "coverage", "ledger"];

/** A deterministic split of tasks into a training set and a held-out set (at least one task in each when there are two or more). */
export function split(cases: Case[], fraction = 0.34, seed = 1): { train: Case[]; heldOut: Case[] } {
  const r = rng(seed), order = cases.map((_, i) => [r(), i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const n = cases.length < 2 ? 0 : Math.max(1, Math.round(cases.length * fraction)), held = new Set(order.slice(0, n));
  return { train: cases.filter((_, i) => !held.has(i)), heldOut: cases.filter((_, i) => held.has(i)) };
}
type Change = { guard?: Guard; stagnation?: number; maxSteps?: number; toolChoice?: "required" };
const withChange = (p: Profile, c: Change): Profile => ({ ...p, ...(c.guard && { off: [...new Set([...(p.off ?? []), c.guard])] }), ...(c.stagnation !== undefined && { stagnationTurns: c.stagnation }),
  ...(c.maxSteps !== undefined && { maxSteps: c.maxSteps }), ...(c.toolChoice && { toolChoice: c.toolChoice }) });
/** What each kind of change is expected to do: removing scaffolding should cost less at the same pass rate; requiring tool calls should pass more. */
const predictionFor = (c: Change): { text: string; held: (dPass: number, dTokens: number) => boolean } =>
  c.toolChoice ? { text: "a higher pass rate (fewer turns lost to prose)", held: (dp) => dp > 0 }
    : { text: "the same pass rate with fewer tokens per solved task", held: (dp, dt) => dp >= -0.02 && Number.isFinite(dt) && dt < 0 };

/** Is `cand` at least as good as `cur` on these cases? Never worse on pass rate, and either better or cheaper per solved task. */
async function compare(cases: Case[], cur: Profile, cand: Profile, o: TuneOptions) {
  const { rows } = await evaluate(cases, [o.makeVariant(cur, "current"), o.makeVariant(cand, "candidate")], { trials: o.trials ?? 2, jobs: o.jobs, baseline: "current", seed: o.seed, onRow: o.onRow });
  const a = analyze(rows, { baseline: "current", seed: o.seed }), c = a.comparisons.find((x) => x.variant === "candidate")!;
  const cheaper = Number.isFinite(c.dTokensPerSolved) && c.dTokensPerSolved < 0;
  const ok = c.verdict !== "worse" && c.dPass >= -0.02 && (c.verdict === "better" || c.dPass > 0 || cheaper);
  return { ok, dPass: c.dPass, dTokens: c.dTokensPerSolved, why: `pass ${c.dPass >= 0 ? "+" : ""}${(c.dPass * 100).toFixed(0)} pts (CI ${(c.ci.lo * 100).toFixed(0)} to ${(c.ci.hi * 100).toFixed(0)}), tokens per solved task ${Number.isFinite(c.dTokensPerSolved) ? Math.round(c.dTokensPerSolved).toLocaleString() : "n/a"}`, minDetectable: a.minDetectable, tasks: a.tasks };
}

export async function tune(o: TuneOptions): Promise<TuneResult> {
  const { train, heldOut } = split(o.cases, o.heldOutFraction, o.seed), steps: Step[] = [], accepted: string[] = [];
  const note = (s: Step) => { steps.push(s); o.onStep?.(s); };
  const startingPoint: Profile = { ...(o.base ?? {}) };
  let cur = startingPoint, strength = "";
  const candidates: { label: string; c: Change }[] = [...(o.guards ?? DEFAULT_GUARDS).filter((g) => !NEVER.includes(g) && !(cur.off ?? []).includes(g)).map((g) => ({ label: `switch off ${g}`, c: { guard: g } })),
    ...(o.stagnationTurns ?? []).map((n) => ({ label: `stagnationTurns = ${n}`, c: { stagnation: n } })), ...(o.maxSteps ?? []).map((n) => ({ label: `maxSteps = ${n}`, c: { maxSteps: n } })),
    ...(o.toolChoice && cur.toolChoice !== "required" ? [{ label: "toolChoice = required", c: { toolChoice: "required" as const } }] : [])];
  for (const { label, c } of candidates) {
    const cand = withChange(cur, c), t = await compare(train, cur, cand, o), pr = predictionFor(c);
    strength = `${t.tasks} training task(s) can only detect differences above ~${(t.minDetectable * 100).toFixed(0)} points`;
    note({ change: label, stage: "train", accepted: t.ok, why: t.why, predicted: pr.text, held: pr.held(t.dPass, t.dTokens) });
    if (t.ok) { cur = cand; accepted.push(label); }
  }
  // The held-out gate: all accepted changes together must not hurt on tasks the search never looked at; otherwise everything is rolled back.
  if (accepted.length) {
    const h = heldOut.length ? await compare(heldOut, startingPoint, cur, o) : { ok: false, why: "no held-out tasks (need at least 2 tasks); nothing is kept without that check" };
    note({ change: accepted.join(" + "), stage: "heldout", accepted: h.ok, why: h.why });
    if (!h.ok) { cur = startingPoint; accepted.length = 0; }
  }
  return { profile: cur, accepted, steps, train: train.map((c) => c.name), heldOut: heldOut.map((c) => c.name), strength };
}

/** Merge a tuned profile into `model`'s entry of a profile file, keeping every other model and field (an earlier version replaced the whole file). */
export function writeProfile(file: string, model: string, p: Profile) {
  let j: { default?: Profile; models?: Record<string, Profile> } = {};
  try { if (existsSync(file)) j = JSON.parse(readFileSync(file, "utf8")); } catch { /* unreadable: start a new one */ }
  j.models = { ...(j.models ?? {}), [model]: { ...(j.models?.[model] ?? {}), ...p, note: "tuned with a held-out check (amness tune)" } };
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
}

/** Tune several models on the same tasks, each on its own: what holds up for a model goes into that model's profile. `shared` lists changes every model kept. */
export async function tuneModels(o: Omit<TuneOptions, "makeVariant"> & { models: { name: string; makeVariant: TuneOptions["makeVariant"] }[] }): Promise<{ results: Record<string, TuneResult>; shared: string[] }> {
  const results: Record<string, TuneResult> = {};
  for (const m of o.models) results[m.name] = await tune({ ...o, makeVariant: m.makeVariant, onStep: (s) => o.onStep?.({ ...s, model: m.name }) });
  const lists = Object.values(results).map((r) => new Set(r.accepted));
  const shared = lists.length ? [...lists[0]].filter((x) => lists.every((l) => l.has(x))) : [];
  return { results, shared };
}

/** Keep a record of a tuning run (every step, prediction and outcome) in `.amness/tune/`, so later runs and people can see what was tried. */
export function archiveTune(dir: string, record: unknown): string {
  mkdirSync(dir, { recursive: true }); const f = `${dir}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(f, JSON.stringify(record, null, 2) + "\n"); return f;
}

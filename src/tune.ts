// `amness tune`: bounded self-improvement of the harness's own settings. The search space is small and fixed (switch one guard off, change a limit), never free-form edits.
// A change is only kept if it holds up twice: on the training tasks, and again on tasks the search never saw. Everything else is rolled back; the profile file is written only on success.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyze, evaluate, type Case, type Row, type Variant } from "./evals.ts";
import type { Profile } from "./profiles.ts";
import type { Guard } from "./harness.ts";
import { rng } from "./stats.ts";

export type Step = { change: string; stage: "train" | "heldout"; accepted: boolean; why: string };
export type TuneResult = { profile: Profile; accepted: string[]; steps: Step[]; train: string[]; heldOut: string[]; strength: string };
export type TuneOptions = {
  cases: Case[];
  /** Build a runnable variant for a profile. `amness tune` uses the real code agent; tests use a scripted one. */
  makeVariant: (profile: Profile, name: string) => Variant;
  base?: Profile; trials?: number; jobs?: number; seed?: number; heldOutFraction?: number;
  guards?: Guard[]; stagnationTurns?: number[]; onStep?: (s: Step) => void; onRow?: (r: Row) => void;
};
const DEFAULT_GUARDS: Guard[] = ["nudge", "loop", "stuck", "wrapup", "condense", "stagnation"];

/** A deterministic split of tasks into a training set and a held-out set (at least one task in each when there are two or more). */
export function split(cases: Case[], fraction = 0.34, seed = 1): { train: Case[]; heldOut: Case[] } {
  const r = rng(seed), order = cases.map((_, i) => [r(), i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const n = cases.length < 2 ? 0 : Math.max(1, Math.round(cases.length * fraction)), held = new Set(order.slice(0, n));
  return { train: cases.filter((_, i) => !held.has(i)), heldOut: cases.filter((_, i) => held.has(i)) };
}
const withChange = (p: Profile, c: { guard?: Guard; stagnation?: number }): Profile => ({ ...p, ...(c.guard && { off: [...new Set([...(p.off ?? []), c.guard])] }), ...(c.stagnation !== undefined && { stagnationTurns: c.stagnation }) });

/** Is `cand` at least as good as `cur` on these cases? Never worse on pass rate, and either better or cheaper per solved task. */
async function compare(cases: Case[], cur: Profile, cand: Profile, o: TuneOptions) {
  const { rows } = await evaluate(cases, [o.makeVariant(cur, "current"), o.makeVariant(cand, "candidate")], { trials: o.trials ?? 2, jobs: o.jobs, baseline: "current", seed: o.seed, onRow: o.onRow });
  const a = analyze(rows, { baseline: "current", seed: o.seed }), c = a.comparisons.find((x) => x.variant === "candidate")!;
  const cheaper = Number.isFinite(c.dTokensPerSolved) && c.dTokensPerSolved < 0;
  const ok = c.verdict !== "worse" && c.dPass >= -0.02 && (c.verdict === "better" || c.dPass > 0 || cheaper);
  return { ok, why: `pass ${c.dPass >= 0 ? "+" : ""}${(c.dPass * 100).toFixed(0)} pts (CI ${(c.ci.lo * 100).toFixed(0)} to ${(c.ci.hi * 100).toFixed(0)}), tokens per solved task ${Number.isFinite(c.dTokensPerSolved) ? Math.round(c.dTokensPerSolved).toLocaleString() : "n/a"}`, minDetectable: a.minDetectable, tasks: a.tasks };
}

export async function tune(o: TuneOptions): Promise<TuneResult> {
  const { train, heldOut } = split(o.cases, o.heldOutFraction, o.seed), steps: Step[] = [], accepted: string[] = [];
  const note = (s: Step) => { steps.push(s); o.onStep?.(s); };
  const startingPoint: Profile = { ...(o.base ?? {}) };
  let cur = startingPoint, strength = "";
  const candidates = [...(o.guards ?? DEFAULT_GUARDS).filter((g) => !(cur.off ?? []).includes(g)).map((g) => ({ label: `switch off ${g}`, c: { guard: g } })), ...(o.stagnationTurns ?? []).map((n) => ({ label: `stagnationTurns = ${n}`, c: { stagnation: n } }))];
  for (const { label, c } of candidates) {
    const cand = withChange(cur, c), t = await compare(train, cur, cand, o);
    strength = `${t.tasks} training task(s) can only detect differences above ~${(t.minDetectable * 100).toFixed(0)} points`;
    note({ change: label, stage: "train", accepted: t.ok, why: t.why });
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

export function writeProfile(file: string, model: string, p: Profile) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ models: { [model]: { ...p, note: "tuned with a held-out check (amness tune)" } } }, null, 2) + "\n"); }

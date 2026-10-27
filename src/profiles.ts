// Harness profiles: settings that depend on the model. Scaffolding that rescued one model is dead weight (or a hazard) for the next, so each model family can switch guards off or
// retune limits, and the eval runner can recommend what to switch off from measurements instead of guesswork.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Analysis } from "./evals.ts";
import type { Guard } from "./harness.ts";

export type Profile = { off?: Guard[]; stagnationTurns?: number; maxSteps?: number; contextBudget?: number; review?: boolean; note?: string };
export type ProfileFile = { default?: Profile; models?: Record<string, Profile> };
const GUARDS: Guard[] = ["nudge", "loop", "compact", "stuck", "wrapup", "condense", "schedule", "ledger", "stagnation", "review", "redact"];

const glob = (pat: string) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
function check(file: string, j: ProfileFile): ProfileFile {
  const bad = (m: string) => new Error(`${file}: ${m}`), one = (name: string, p: Profile) => {
    if (p.off !== undefined && (!Array.isArray(p.off) || p.off.some((g) => !GUARDS.includes(g)))) throw bad(`${name}: "off" must be a list of guards (${GUARDS.join(", ")})`);
    for (const k of ["stagnationTurns", "maxSteps", "contextBudget"] as const) if (p[k] !== undefined && (typeof p[k] !== "number" || p[k]! < 0)) throw bad(`${name}: "${k}" must be a non-negative number`);
  };
  if (j.default) one("default", j.default); for (const [m, p] of Object.entries(j.models ?? {})) one(m, p);
  return j;
}
/** The profile for `model`: the user's file first, then the project's (the project's values win), then the matching `models` entries (most specific pattern last). */
export function loadProfile(cwd: string, model: string, o: { userDir?: string } = {}): { profile: Profile; sources: string[] } {
  const files = [join(o.userDir ?? process.env.AMNESS_HOME ?? join(homedir(), ".amness"), "profile.json"), join(cwd, ".amness", "profile.json")], merged: Profile = {}, sources: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue; const j = check(f, JSON.parse(readFileSync(f, "utf8")) as ProfileFile);
    const picks = [j.default, ...Object.entries(j.models ?? {}).filter(([pat]) => glob(pat).test(model)).sort(([a], [b]) => a.length - b.length).map(([, p]) => p)].filter(Boolean) as Profile[];
    for (const p of picks) { Object.assign(merged, p, { off: [...new Set([...(merged.off ?? []), ...(p.off ?? [])])] }); sources.push(f); }
  }
  return { profile: merged, sources };
}

export type GuardVerdict = { guard: string; action: "remove" | "keep" | "undecided"; why: string };
/**
 * Read an ablation (`full` against `full-<guard>` for each guard) and say, per guard, whether removing it is supported by the data.
 * Conservative on purpose: a guard is only recommended for removal when taking it out is significantly better, or when it is not worse and clearly cheaper;
 * a guard whose removal significantly hurts is load-bearing; anything else is "undecided" and stays on.
 */
export function recommend(a: Analysis, fullName = "full"): { verdicts: GuardVerdict[]; profile: Profile; strength: string } {
  const verdicts: GuardVerdict[] = [];
  for (const c of a.comparisons) {
    const m = /^full-(.+)$/.exec(c.variant); if (!m || c.vs !== fullName) continue;
    const pts = (x: number) => `${(x * 100).toFixed(0)} pts`, cheaper = c.dTokensPerSolved < 0 && Number.isFinite(c.dTokensPerSolved);
    if (c.verdict === "worse") verdicts.push({ guard: m[1], action: "keep", why: `removing it loses ${pts(-c.dPass)} (95% CI ${pts(c.ci.lo)} to ${pts(c.ci.hi)})` });
    else if (c.verdict === "better") verdicts.push({ guard: m[1], action: "remove", why: `removing it gains ${pts(c.dPass)} (95% CI ${pts(c.ci.lo)} to ${pts(c.ci.hi)})` });
    else if (Math.abs(c.dPass) <= 0.02 && cheaper && c.ci.lo > -0.1) verdicts.push({ guard: m[1], action: "remove", why: `removing it makes no real difference to the pass rate (${pts(c.dPass)}, CI ${pts(c.ci.lo)} to ${pts(c.ci.hi)}) and lowers tokens per solved task by ${Math.round(-c.dTokensPerSolved).toLocaleString()}` });
    else verdicts.push({ guard: m[1], action: "undecided", why: `no clear effect (${pts(c.dPass)}, CI ${pts(c.ci.lo)} to ${pts(c.ci.hi)}); it stays on` });
  }
  const strength = a.minDetectable > 0.4 ? `weak evidence: ${a.tasks} task(s) can only detect differences above ~${(a.minDetectable * 100).toFixed(0)} points; add tasks before acting on "remove"` : `${a.tasks} tasks × ${a.trials} trial(s): differences above ~${(a.minDetectable * 100).toFixed(0)} points are detectable`;
  const off = verdicts.filter((v) => v.action === "remove" && GUARDS.includes(v.guard as Guard)).map((v) => v.guard as Guard);
  return { verdicts, profile: { ...(off.length ? { off } : {}), note: `from an ablation of ${a.tasks} task(s) × ${a.trials} trial(s)` }, strength };
}

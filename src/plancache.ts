// Plan cache (after "Agentic Plan Caching", arXiv 2506.14852: reuse the plan, not the answer). When a task finishes, keep a short plan made from what was actually done:
// the files changed, the commands that checked the work, and the closing summary. When a similar task comes in, offer that plan as a starting point.
// The plan is advice, not an answer: the code may have changed, so the model is told to verify each step. Only finished runs are stored, and a plan that is offered but does not lead to a finished run is forgotten after two misses.
// Off by default until measured. Plans stay on this machine, in .amness/plans.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "./harness.ts";

export type StoredPlan = { id: string; task: string; words: string[]; plan: string; at: string; offered: number; helped: number; failed: number };

const STOP = new Set("the and for with that this from into then than have has are was were you your can could should would will its it's a an of to in on at by is be as or not no do does did how what where when why which who please make use using add fix update change create write run need want like also just about all any some more most each every".split(" "));
export const words = (text: string): string[] => [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []).filter((w) => !STOP.has(w)))];
/** Overlap of two word sets, 0 to 1 (Jaccard). */
export const similarity = (a: string[], b: string[]): number => { const sb = new Set(b), both = a.filter((w) => sb.has(w)).length; return a.length + b.length - both === 0 ? 0 : both / (a.length + b.length - both); };

/** A plan from what happened: changed files, checking commands, and the summary the model gave. Mechanical, no model call. */
export function planFrom(messages: Message[], summary: string): string {
  const files: string[] = [], cmds: string[] = [];
  for (const m of messages) for (const c of m.tool_calls ?? []) {
    let a: any; try { a = JSON.parse(c.function.arguments); } catch { continue; }
    if (/^(edit_file|write_file|apply_patch|multi_edit)$/.test(c.function.name) && typeof a.path === "string" && !files.includes(a.path)) files.push(a.path);
    else if (c.function.name === "sh" && typeof a.cmd === "string" && /\b(test|build|lint|tsc|check|pytest|cargo|go|make|npm|node|python)\b/.test(a.cmd) && !cmds.includes(a.cmd)) cmds.push(a.cmd.slice(0, 120));
  }
  const parts = [files.length ? `Changed: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}.` : "", cmds.length ? `Checked with: ${cmds.slice(-3).join(" ; ")}.` : "", summary ? `Result: ${summary.replace(/\s+/g, " ").slice(0, 400)}` : ""];
  return parts.filter(Boolean).join("\n").slice(0, 900);
}

export class PlanCache {
  private dir: string;
  constructor(dir: string) { this.dir = dir; }
  private all(): StoredPlan[] { if (!existsSync(this.dir)) return []; const out: StoredPlan[] = []; for (const f of readdirSync(this.dir)) if (f.endsWith(".json")) { try { out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8"))); } catch { /* skip a damaged file */ } } return out; }
  private save(p: StoredPlan) { mkdirSync(this.dir, { recursive: true }); writeFileSync(join(this.dir, `${p.id}.json`), JSON.stringify(p, null, 1)); }
  /** Store the plan of a finished run. A near-identical task replaces its older plan instead of piling up. */
  record(task: string, plan: string): StoredPlan | undefined {
    const w = words(task); if (w.length < 3 || !plan) return undefined;
    const old = this.all().find((p) => similarity(w, p.words) >= 0.85);
    const p: StoredPlan = { id: old?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, task: task.slice(0, 300), words: w, plan, at: new Date().toISOString(), offered: old?.offered ?? 0, helped: old?.helped ?? 0, failed: 0 };
    this.save(p); return p;
  }
  /** The most similar stored plan for a task, if it is similar enough. */
  find(task: string, min = 0.45): { plan: StoredPlan; similarity: number } | undefined {
    const w = words(task); let best: { plan: StoredPlan; similarity: number } | undefined;
    for (const p of this.all()) { if (p.failed >= 2) continue; const s = similarity(w, p.words); if (s >= min && (!best || s > best.similarity)) best = { plan: p, similarity: s }; }
    if (best) { best.plan.offered++; this.save(best.plan); }
    return best;
  }
  /** Tell the cache how an offered plan turned out. Two failures in a row retire it. */
  outcome(id: string, finished: boolean) {
    const p = this.all().find((x) => x.id === id); if (!p) return;
    if (finished) { p.helped++; p.failed = 0; this.save(p); } else if (++p.failed >= 2) rmSync(join(this.dir, `${p.id}.json`), { force: true }); else this.save(p);
  }
  stats() { const a = this.all(); return { plans: a.length, offered: a.reduce((n, p) => n + p.offered, 0), helped: a.reduce((n, p) => n + p.helped, 0) }; }
}

/** The text added to a task when a similar plan exists. */
export const planBlock = (p: StoredPlan, sim: number): string => `## A plan from a similar past task (${Math.round(sim * 100)}% similar)\nThen: ${p.task.replace(/\s+/g, " ")}\n${p.plan}\nUse this as a starting point only. The code may have changed since: check each step before relying on it, and say if the plan did not fit.`;

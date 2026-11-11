// The recovery ladder: several models, cheapest first, and a rule for when to move up or back down.
// After a cheap model fails, choosing among reflect, replan and escalate beat a binary cascade (CodeRescue, arXiv 2607.19338, read);
// risk accumulated over the run predicted handoff better than the last step's signal, and a permanent one-way handoff can be worse than
// brief strong help and a return to the cheap model (TACIT-Switch, arXiv 2608.27911, read). No training: weights are constants in one table.
import type { Event, Model, ModelOpts, Message, ToolSpec } from "./harness.ts";

export type LadderTier = { model: Model; label: string };
export type LadderModel = Model & { readonly index: number; readonly top: number; readonly start: number; label(i?: number): string; moveTo(i: number): void };

/** One model object that sends each call to the tier in use. Its card and appendOnly are those of that tier. */
export function ladderModel(tiers: LadderTier[], start = 0): LadderModel {
  if (!tiers.length) throw new Error("a ladder needs at least one model");
  let i = Math.max(0, Math.min(start, tiers.length - 1));
  const m = (async (messages: Message[], tools: ToolSpec[], opts?: ModelOpts) => tiers[i].model(messages, tools, opts)) as LadderModel;
  Object.defineProperties(m, {
    index: { get: () => i }, top: { get: () => tiers.length - 1 }, start: { value: Math.max(0, Math.min(start, tiers.length - 1)) },
    appendOnly: { get: () => tiers[i].model.appendOnly, enumerable: true, configurable: true },
    card: { get: () => tiers[i].model.card, enumerable: true, configurable: true },
    api: { get: () => tiers[i].model.api, enumerable: true, configurable: true },
  });
  m.label = (k = i) => tiers[k]?.label ?? "?";
  m.moveTo = (k) => { i = Math.max(0, Math.min(k, tiers.length - 1)); };
  return m;
}

/** How much each signal adds to the risk score. One table, so `amness tune` can search it later. */
export const RISK_WEIGHTS = { repair: 1, toolError: 1, loop: 3, nudge: 1, stuck: 4, rejected: 3, editFailed: 2 } as const;
/** How much clean progress takes off. */
export const RISK_RELIEF = { verifyPassed: 4, editOk: 2, cleanTurn: 1 } as const;
/** Score at which each action is tried: reflect first, then a fresh start on the same model, then the next tier up. */
export const LADDER_LEVELS = { reflect: 5, replan: 9, escalate: 13 } as const;

/** The risk score of a run, accumulated from the harness's own events; it decays on clean progress. */
export class RiskMeter {
  score = 0; cleanTurns = 0; private turnTrouble = false;
  observe(e: Event) {
    const add = (n: number) => { this.score += n; this.turnTrouble = true; };
    switch (e.kind) {
      case "repair": if (!e.fixed) add(RISK_WEIGHTS.repair); break;
      case "loop": add(RISK_WEIGHTS.loop); break;
      case "nudge": add(/stuck|stagnation/.test(e.detail) ? RISK_WEIGHTS.stuck : RISK_WEIGHTS.nudge); break;
      case "rejected": add(RISK_WEIGHTS.rejected); break;
      case "tool": if (/^(ERROR|DENIED)/.test(e.result)) add(/^(edit_file|write_file|apply_patch)$/.test(e.name) ? RISK_WEIGHTS.editFailed : RISK_WEIGHTS.toolError);
        else if (/^(edit_file|write_file|apply_patch)$/.test(e.name)) this.relieve(RISK_RELIEF.editOk);
        else if (e.name === "sh" && /^exit=0\b/.test(e.result) && /\b(test|build|check|lint|tsc|pytest|jest|cargo)\b/.test(e.args)) this.relieve(RISK_RELIEF.verifyPassed);
        break;
    }
  }
  /** Call at the end of each turn. */
  endTurn() { this.cleanTurns = this.turnTrouble ? 0 : this.cleanTurns + 1; if (!this.turnTrouble) this.relieve(RISK_RELIEF.cleanTurn); this.turnTrouble = false; }
  reset() { this.score = 0; this.cleanTurns = 0; this.turnTrouble = false; }
  private relieve(n: number) { this.score = Math.max(0, this.score - n); }
}

export type LadderState = { score: number; cleanTurns: number; index: number; start: number; top: number; step: number; tried: ReadonlySet<string>; /** the last turns only read (a mechanical stretch) */ readOnlyStreak: number };
export type LadderAction = { action: "none" | "reflect" | "replan" | "escalate" | "down"; reason: string };

/**
 * The next recovery action, a pure function (tested as a table). Each action is tried once per climb before the next one.
 * Step down after a clean stretch above the start tier, when the remaining work looks mechanical.
 */
export function ladderDecide(s: LadderState): LadderAction {
  if (s.step === 0) return { action: "none", reason: "the first step runs on the start tier" };
  if (s.index > s.start && s.score === 0 && s.cleanTurns >= 4 && s.readOnlyStreak >= 2) return { action: "down", reason: `${s.cleanTurns} clean turns and the work looks mechanical` };
  if (s.score >= LADDER_LEVELS.escalate && s.index < s.top && s.tried.has("replan")) return { action: "escalate", reason: `risk ${s.score}: reflecting and a fresh start did not help` };
  if (s.score >= LADDER_LEVELS.replan && !s.tried.has("replan") && s.tried.has("reflect")) return { action: "replan", reason: `risk ${s.score}: start again from a note, on the same model` };
  if (s.score >= LADDER_LEVELS.reflect && !s.tried.has("reflect")) return { action: "reflect", reason: `risk ${s.score}: reflect first` };
  return { action: "none", reason: `risk ${s.score}` };
}

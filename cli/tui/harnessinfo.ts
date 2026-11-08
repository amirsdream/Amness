// The agent loop's switches as /harness and the desktop's Harness settings show them: what each guard does, in one line, and what it defaults to.
// The names are the harness's own Guard ids (src/harness.ts), so `off` here is passed straight to the agent; `amness eval` can switch each one off too (full-<guard>).
import type { Config } from "../config.ts";

export type GuardInfo = { name: string; label: string; what: string };
export const GUARDS: GuardInfo[] = [
  { name: "loop", label: "Repeated-call guard", what: "blocks a tool call that repeats the same call with the same arguments" },
  { name: "stagnation", label: "No-progress stop", what: "stops the run when several turns in a row change nothing measurable (see the limit below)" },
  { name: "stuck", label: "Stuck detection", what: "notices repeated failures of the same kind and asks the model to change approach" },
  { name: "nudge", label: "Nudges", what: "reminds the model to act when it only describes what it will do, and shows it the budget it has used" },
  { name: "wrapup", label: "Wrap-up", what: "near the step limit or the budget, asks the model to finish; if the budget runs out, writes a final report" },
  { name: "ledger", label: "Grounded finish", what: "keeps a record of what really ran (edits, commands, exit codes) and checks the model's finish against it" },
  { name: "coverage", label: "Read-each-file check", what: "refuses a finish when the task asked to read every file and some listed files were never read" },
  { name: "compact", label: "Context trimming", what: "shortens old tool output and writes a handoff note when the context fills up" },
  { name: "condense", label: "Short tool output", what: "shortens each tool result when it arrives (keeps the start, the end and the error lines)" },
  { name: "readdelta", label: "Send each file line once", what: "a re-read of an unchanged file sends only the lines the model does not have yet" },
  { name: "toolcache", label: "Read cache", what: "answers a repeated read of an unchanged file with a one-line pointer to the earlier result" },
  { name: "schedule", label: "Parallel reads", what: "runs read-only tool calls of one step at the same time" },
  { name: "redact", label: "Secret masking", what: "masks keys and passwords in tool output before the model sees them" },
  { name: "audit", label: "Unused new files", what: "refuses the first finish when new source files the agent made are imported by nothing (tests passing while the real code is not wired up), unless they are meant to stand alone" },
  { name: "anchor", label: "Related files in searches", what: "after a search, adds a few lines from the code index: which files import the files it hit, and which tests cover them" },
  { name: "pin", label: "Keep your rules", what: "when the context is reset with a handoff note, the rules from your messages (never, always, don't…) are kept word for word, not only summarised" },
];
export const HARNESS_DEFAULTS = { maxSteps: 60, stagnationTurns: 8, contextBudget: 60_000 } as const;     // the chat defaults in src/code.ts and src/harness.ts

/** The harness settings in effect: defaults, then the model profile (`profile`), then your own (`cfg.harness`). */
export function harnessView(cfg: Pick<Config, "harness">, profile: { off?: string[]; maxSteps?: number; stagnationTurns?: number } = {}) {
  const h = cfg.harness ?? {}, off = new Set([...(profile.off ?? []), ...(h.off ?? [])]);
  return {
    guards: GUARDS.map((g) => ({ ...g, on: !off.has(g.name), byProfile: (profile.off ?? []).includes(g.name) })),
    maxSteps: h.maxSteps ?? profile.maxSteps ?? HARNESS_DEFAULTS.maxSteps, stagnationTurns: h.stagnationTurns ?? profile.stagnationTurns ?? HARNESS_DEFAULTS.stagnationTurns,
    contextBudget: h.contextBudget ?? HARNESS_DEFAULTS.contextBudget, governRewrites: !!h.governRewrites,
  };
}

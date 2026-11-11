// The harness card: what a run's harness really was, in seven layers, recorded next to every score.
// Scores of agents are not comparable without the harness (harness changes moved pass@1 more than model changes in a controlled
// 3x3 study, and six of nine model-pair rankings reversed across harnesses; "Stop Comparing LLM Agents Without Disclosing the Harness",
// arXiv 2605.23950, read). The paper asks for these layers: execution, tools, context, scheduling, observability, verification, governance.
import { GUARD_NAMES, type Guard } from "./harness.ts";

export type HarnessCardInput = {
  version: string;
  model: { provider: string; id: string; tier?: string; window?: number | null; profileSources?: string[] };
  roles?: Record<string, string>;
  router?: boolean; fallback?: string;
  maxSteps?: number; maxTime?: number | null; maxTokens?: number;
  off?: Guard[]; toolChoice?: string; textToolCalls?: boolean; thinkingBudget?: number | null; keepThinking?: boolean;
  tools?: string[]; subagents?: boolean; plugins?: string[]; mcp?: number;
  sandbox?: string | null; sandboxEngine?: string | null; quarantine?: boolean; taint?: string;
  verify?: string | null; review?: boolean; approvalReviewer?: boolean;
  trace?: boolean; memory?: boolean;
};

export type HarnessCard = {
  version: string;
  execution: { model: string; provider: string; tier: string | null; roles: Record<string, string>; router: boolean; fallback: string | null; maxSteps: number; maxTime: number | null; maxTokens: number | null };
  tools: { offered: string[] | null; subagents: boolean; plugins: string[]; mcpServers: number; toolChoice: string; argumentRepair: boolean; textToolCalls: boolean };
  context: { window: number | null; compaction: boolean; condense: boolean; pinRules: boolean; keepThinking: boolean; thinkingBudget: number | null; memory: boolean };
  scheduling: { parallelReads: boolean; loopGuard: boolean; stuck: boolean; stagnation: boolean; wrapup: boolean; nudge: boolean };
  observability: { trace: boolean; events: "jsonl" };
  verification: { verify: string | null; ledger: boolean; coverage: boolean; audit: boolean; review: boolean };
  governance: { sandbox: string | null; sandboxEngine: string | null; taint: string; quarantine: boolean; approvalReviewer: boolean; redact: boolean; profileSources: string[] };
};

/** Fill the seven layers from the settings a run really used. Every guard is reported by whether it is on, so a card shows an ablation at a glance. */
export function harnessCard(i: HarnessCardInput): HarnessCard {
  const off = new Set(i.off ?? []), on = (g: Guard) => GUARD_NAMES.includes(g) && !off.has(g);
  return {
    version: i.version,
    execution: { model: i.model.id, provider: i.model.provider, tier: i.model.tier ?? null, roles: i.roles ?? {}, router: !!i.router, fallback: i.fallback ?? null, maxSteps: i.maxSteps ?? 40, maxTime: i.maxTime ?? null, maxTokens: i.maxTokens ?? null },
    tools: { offered: i.tools ?? null, subagents: !!i.subagents, plugins: i.plugins ?? [], mcpServers: i.mcp ?? 0, toolChoice: i.toolChoice ?? "auto", argumentRepair: on("argfix"), textToolCalls: !!i.textToolCalls },
    context: { window: i.model.window ?? null, compaction: on("compact"), condense: on("condense"), pinRules: on("pin"), keepThinking: !!i.keepThinking, thinkingBudget: i.thinkingBudget ?? null, memory: i.memory !== false },
    scheduling: { parallelReads: on("schedule"), loopGuard: on("loop"), stuck: on("stuck"), stagnation: on("stagnation"), wrapup: on("wrapup"), nudge: on("nudge") },
    observability: { trace: !!i.trace, events: "jsonl" },
    verification: { verify: i.verify ?? null, ledger: on("ledger"), coverage: on("coverage"), audit: on("audit"), review: !!i.review && on("review") },
    governance: { sandbox: i.sandbox ?? null, sandboxEngine: i.sandboxEngine ?? null, taint: i.taint ?? "ask", quarantine: !!i.quarantine, approvalReviewer: !!i.approvalReviewer, redact: on("redact"), profileSources: i.model.profileSources ?? [] },
  };
}

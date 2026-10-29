// Chaos for evals: break things on purpose and see whether the harness recovers. A harness that only works when every tool call and every API call succeeds is not ready for real use.
// These wrap a model or a tool list; `amness eval --variants full,chaos:tools,chaos:429` runs the normal harness under each kind of failure.
import type { Message, Model, ModelOpts, Tool, ToolSpec } from "./harness.ts";
import { rng } from "./stats.ts";

export type ChaosKind = "tools" | "429" | "args" | "slow-tools";
export const CHAOS_KINDS: ChaosKind[] = ["tools", "429", "args", "slow-tools"];

/** Make some tool calls fail with an error the model has to read and work around (never the finish tool). */
export function chaosTools(tools: Tool[], o: { rate?: number; seed?: number; delayMs?: number } = {}): Tool[] {
  const r = rng(o.seed ?? 1), rate = o.rate ?? 0.25;
  return tools.map((t) => ({ ...t, run: async (a: any, c: any) => {
    if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs));
    if (r() < rate) return `ERROR: simulated failure in ${t.name} (chaos test): try again or use another approach`;
    return t.run(a, c);
  } }));
}
/** Make some model calls fail with a recoverable 429 and Retry-After (the rate limiter should absorb it), or answer with broken tool arguments (the harness should ask for a fix). */
export function chaosModel(model: Model, o: { kind: "429" | "args"; rate?: number; seed?: number }): Model {
  const r = rng(o.seed ?? 1), rate = o.rate ?? 0.3;
  const call = (async (messages: Message[], tools: ToolSpec[], opts?: ModelOpts) => {
    if (o.kind === "429" && r() < rate) throw Object.assign(new Error("HTTP 429: rate limit reached (chaos test)"), { status: 429, retryAfterMs: 50 });
    const m = await model(messages, tools, opts);
    if (o.kind === "args" && m.tool_calls?.length && r() < rate) return { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: (c.function.arguments || "{}").slice(0, -1) } })) };   // truncated JSON
    return m;
  }) as Model;
  return Object.assign(call, model);
}

import type { Message, Model, ToolCall, ToolSpec } from "./harness.ts";

/**
 * Claude backend via the official Anthropic SDK (an optional dependency, installed with the package: `npm i @anthropic-ai/sdk` if it is missing).
 * Defaults follow Anthropic's guidance for agent loops: adaptive thinking, auto prompt caching, streaming,
 * server-side refusal fallbacks. Credentials: `apiKey`, ANTHROPIC_API_KEY, or an `ant auth login` profile.
 */
export type AnthropicOptions = {
  /** Advisory token budget for each agentic turn (Claude's `task_budget`, beta): the model sees a running countdown and wraps up gracefully. At least 20000; only sent to models that support it. Set once; it is not changed between requests (that would break the prompt cache). */
  taskBudget?: number;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Re-run a safety-declined request on Anthropic's recommended fallback model. Default: on where the model supports it. */
  fallbacks?: boolean;
  /** Adaptive thinking. Default: on for models that support it. */
  thinking?: boolean;
  /** Inject a client (tests, proxies, Bedrock/Vertex clients). */
  client?: any;
};

export const DEFAULT_CLAUDE = "claude-opus-5-5";
const ADAPTIVE = /^claude-(opus-(4-[6-8]|5)|sonnet-(4-6|5)|fable|mythos|haiku-5)/;
const FALLBACK_OK = /^claude-(opus-5|fable-|sonnet-5-5|mythos-)/;
const isError = (s: string | null) => /^(ERROR|DENIED|REJECTED)/.test(s ?? "");
const parse = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

/** Our transcript -> Anthropic `system` + `messages`. Parallel tool results are merged into ONE user message, as the API wants. */
export function toAnthropic(msgs: Message[]): { system?: string; messages: any[] } {
  let system: string | undefined;
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks); else out.push({ role, content: blocks });
  };
  for (const m of msgs) {
    if (m.role === "system") system = (system ? system + "\n\n" : "") + (m.content ?? "");
    else if (m.role === "user") push("user", [...(m.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: m.content || "(continue)" }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "", ...(isError(m.content) && { is_error: true }) }]);
    else {
      const blocks = Array.isArray(m.raw) ? m.raw : [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...(m.tool_calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.function.name, input: parse(c.function.arguments) })),
      ];
      push("assistant", blocks.length ? blocks : [{ type: "text", text: "(no output)" }]);
    }
  }
  return { system, messages: out };
}

/** Anthropic response -> our Message, keeping the native blocks (thinking!) in `raw`. */
export function fromAnthropic(r: any): Message {
  const blocks: any[] = r.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  let calls: ToolCall[] = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  let content: string | null = text || null, raw = blocks;
  if (r.stop_reason === "refusal" && !calls.length) content = `[model declined: ${r.stop_details?.category ?? "policy"}] ${text}`.trim();
  if (r.stop_reason === "max_tokens" && calls.length) {
    // A tool call cut off mid-JSON must never run. Drop it and nudge the model to go smaller (the "I'll" trips the harness nudge).
    calls = []; raw = blocks.filter((b) => b.type !== "tool_use");
    content = `${text}\n[output hit the max_tokens limit; I'll redo that in smaller steps]`.trim();
  }
  const u = r.usage ?? {}, input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    role: "assistant", content, raw, ...(calls.length && { tool_calls: calls }),
    usage: { prompt_tokens: input, completion_tokens: u.output_tokens ?? 0, total_tokens: input + (u.output_tokens ?? 0), cached_tokens: u.cache_read_input_tokens ?? 0 },
  };
}

const toTool = (t: ToolSpec) => ({
  name: t.name, ...(t.description && { description: t.description }),
  input_schema: t.parameters.type === "object" ? t.parameters : { type: "object", properties: {} },
});

/** Models that accept `task_budget` (beta). Not Sonnet 5, Opus 4.6, Sonnet 4.6 or Haiku 4.5. */
const TASK_BUDGET_OK = /claude-(fable|mythos|opus-(4-7|4-8|5)|sonnet-5-5|haiku-5-5)/;
export function anthropic(o: AnthropicOptions = {}): Model {
  const model = o.model ?? process.env.AMNESS_MODEL ?? DEFAULT_CLAUDE;
  const fallbacks = o.fallbacks ?? FALLBACK_OK.test(model);
  const thinking = o.thinking ?? ADAPTIVE.test(model);
  const taskBudget = o.taskBudget && o.taskBudget >= 20_000 && TASK_BUDGET_OK.test(model) ? o.taskBudget : undefined;
  let client: any = o.client;

  const call: Model = async (messages, tools, opts) => {
    client ??= await import("@anthropic-ai/sdk").then(
      (m) => new m.default({ ...(o.apiKey && { apiKey: o.apiKey }), ...(o.baseUrl && { baseURL: o.baseUrl }) }),
      () => { throw new Error("Claude support needs the SDK: npm install @anthropic-ai/sdk"); });
    const { system, messages: msgs } = toAnthropic(messages);
    const req = {
      model, max_tokens: opts?.maxTokens ?? o.maxTokens ?? 32_000, ...(system && { system }), messages: msgs,
      ...(tools.length && { tools: tools.map(toTool) }),
      ...((thinking || taskBudget) && { ...(thinking && { thinking: { type: "adaptive" } }), output_config: { ...(thinking && { effort: o.effort ?? "high" }), ...(taskBudget && { task_budget: { type: "tokens", total: taskBudget } }) } }),
      cache_control: { type: "ephemeral" }, // the transcript is append-only, so each turn reads the previous one from cache
    };
    // Streaming avoids HTTP timeouts on long outputs; we only need the assembled message.
    const betas = [...(fallbacks ? ["server-side-fallback-2026-07-01"] : []), ...(taskBudget ? ["task-budgets-2026-03-13"] : [])];
    const stream = betas.length
      ? client.beta.messages.stream({ ...req, betas, ...(fallbacks && { fallbacks: "default" }) }, { signal: opts?.signal })
      : client.messages.stream(req, { signal: opts?.signal });
    if (opts?.onText) stream.on?.("text", (delta: string) => opts.onText!(delta));
    return fromAnthropic(await stream.finalMessage());
  };
  call.appendOnly = true;
  return call;
}

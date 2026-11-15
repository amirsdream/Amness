// "Where did my tokens go?": estimates what fills the context window and renders a compact report.
import type { Message } from "../../src/index.ts";
import { contextWindow, estimateCost, fmtCost, fmtTokens, priceOf } from "./pricing.ts";
import { bold, palette, type RGB } from "./theme.ts";
import { renderBlocks, type ReportBlock } from "./report.ts";

export type ContextMap = { parts: { key: "system" | "you" | "assistant" | "tools" | "defs"; label: string; tokens: number; color: RGB }[]; total: number; biggest?: { name: string; tokens: number } };

const approx = (chars: number) => Math.ceil(chars / 3.6);

/**
 * Attribute the conversation's size to who produced it. Sizes are character-based estimates; when the API told us the real prompt size
 * (`promptTokens`) the estimates are scaled so the total matches it.
 */
export function contextMap(messages: Message[], promptTokens = 0, toolDefChars = 0): ContextMap {
  const chars = { system: 0, you: 0, assistant: 0, tools: 0 };
  const names = new Map<string, string>();
  let biggest: { name: string; chars: number } | undefined;
  for (const m of messages) {
    const calls = (m.tool_calls ?? []).reduce((n, c) => n + c.function.arguments.length + c.function.name.length, 0);
    if (m.role === "system") chars.system += m.content?.length ?? 0;
    else if (m.role === "user") chars.you += m.content?.length ?? 0;
    else if (m.role === "assistant") { chars.assistant += (m.content?.length ?? 0) + calls; for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name); }
    else {
      const n = m.content?.length ?? 0; chars.tools += n;
      if (!biggest || n > biggest.chars) biggest = { name: names.get(m.tool_call_id ?? "") ?? "tool", chars: n };
    }
  }
  const est = { system: approx(chars.system), you: approx(chars.you), assistant: approx(chars.assistant), tools: approx(chars.tools), defs: approx(toolDefChars) };
  const sum = est.system + est.you + est.assistant + est.tools + est.defs, k = promptTokens && sum ? promptTokens / sum : 1;
  const parts: ContextMap["parts"] = [
    { key: "tools", label: "tool output", tokens: Math.round(est.tools * k), color: palette.read },
    { key: "assistant", label: "assistant", tokens: Math.round(est.assistant * k), color: palette.edit },
    { key: "you", label: "you", tokens: Math.round(est.you * k), color: palette.memory },
    { key: "system", label: "system", tokens: Math.round(est.system * k), color: palette.shell },
    { key: "defs", label: "tool defs", tokens: Math.round(est.defs * k), color: palette.web },        // the JSON schemas of every tool ride along on each request
  ];
  return { parts, total: parts.reduce((n, p) => n + p.tokens, 0), biggest: biggest ? { name: biggest.name, tokens: Math.round(approx(biggest.chars) * k) } : undefined };
}

export type ReportInput = {
  model: string; messages: Message[]; usage: { prompt: number; completion: number; calls: number; cached?: number; reasoning?: number }; series: number[];
  /** context window in tokens; default: the known size for the model */ window?: number; lastPrompt: number; turnTokens: number; turnBudget: number; width: number; /** size of the tool definitions sent with every request */ toolDefChars?: number;
};

/** The /tokens report as structured blocks (cli/tui/report.ts): the terminal and the desktop each draw it in their own style. */
export function tokenBlocks(r: ReportInput): ReportBlock[] {
  const win = r.window ?? contextWindow(r.model), used = r.lastPrompt || contextMap(r.messages, 0, r.toolDefChars).total, pct = Math.min(100, Math.round((used / win) * 100));
  const map = contextMap(r.messages, r.lastPrompt, r.toolDefChars), total = Math.max(1, map.parts.reduce((n, p) => n + p.tokens, 0));
  const cached = r.usage.cached ?? 0, reasoning = r.usage.reasoning ?? 0;
  const cost = estimateCost(r.model, r.usage.prompt, r.usage.completion, cached), p = priceOf(r.model);
  const perReq = r.usage.calls ? Math.round(r.usage.prompt / r.usage.calls) : 0;
  const out: ReportBlock[] = [
    { kind: "meter", label: "context window", pct, detail: `${fmtTokens(used)} of ${fmtTokens(win)}` },
    { kind: "segments", label: "what fills it", parts: map.parts.map((x) => ({ label: x.label, pct: Math.round((x.tokens / total) * 100), color: (x.color[0] << 16) | (x.color[1] << 8) | x.color[2] })) },
  ];
  if (map.biggest && map.biggest.tokens > 800) out.push({ kind: "kv", rows: [{ key: "biggest item", value: `one ${map.biggest.name} result is ~${fmtTokens(map.biggest.tokens)} tokens`, tone: "warn" }] });
  if (r.series.length) out.push({ kind: "spark", label: "prompt size/req", values: r.series, detail: `${r.series.length} requests, latest ${fmtTokens(r.series.at(-1)!)}` });
  const rows: Extract<ReportBlock, { kind: "kv" }>["rows"] = [];
  if (cached) rows.push({ key: "prompt cache", value: `${Math.round((cached / Math.max(1, r.usage.prompt)) * 100)}% of input served from cache`, tone: "ok", hint: `${fmtTokens(cached)} tokens at ~10% price` });
  if (reasoning) rows.push({ key: "reasoning", value: `${fmtTokens(reasoning)} hidden reasoning tokens (${Math.round((reasoning / Math.max(1, r.usage.completion)) * 100)}% of output)` });
  rows.push({ key: "this chat", value: `${fmtTokens(r.usage.prompt)} in · ${fmtTokens(r.usage.completion)} out · ${r.usage.calls} request${r.usage.calls === 1 ? "" : "s"}${perReq ? ` (avg ${fmtTokens(perReq)} in)` : ""}` });
  const price = p ? "at " + "$" + p[1] + "/" + "$" + p[2] + " per M tokens" + (cached ? ", cached input at 10%" : "") : undefined;
  rows.push(cost === null ? { key: "est. cost", value: "unknown for this model", tone: "muted" } : { key: "est. cost", value: fmtCost(cost), hint: price });
  out.push({ kind: "kv", rows });
  if (r.turnBudget && r.turnTokens) out.push({ kind: "meter", label: "turn budget", pct: Math.min(100, Math.round((r.turnTokens / r.turnBudget) * 100)), detail: `${fmtTokens(r.turnTokens)} of ${fmtTokens(r.turnBudget)}` });
  const advice = pct >= 85 ? { text: "! nearly full: run /compact now, or /clear to start fresh", tone: "err" as const } : pct >= 60 ? { text: "↯ getting full: /compact will summarise and free most of it", tone: "warn" as const } : map.parts[0].key === "tools" && map.parts[0].tokens > used * 0.5 ? { text: "i mostly tool output: ask for narrower reads (line ranges, grep) to keep it lean", tone: "accent" as const } : undefined;
  if (advice) out.push({ kind: "note", ...advice });
  return out;
}

/** The /tokens report as terminal lines. */
export function tokenReport(r: ReportInput): string[] { return ["", `  ${bold("Tokens")}`, ...renderBlocks(tokenBlocks(r), r.width)]; }


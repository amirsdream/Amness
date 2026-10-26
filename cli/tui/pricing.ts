// Rough price + context-window tables so the footer can show cost and context use. Estimates only: cache discounts are not modelled.
const PRICES: [RegExp, number, number][] = [   // [model pattern, $/1M input, $/1M output]
  [/gpt-6-astra/, 10, 50], [/gpt-6(\.\d+)?-sol/, 2, 10], [/gpt-6(\.\d+)?-terra/, 1, 5], [/gpt-6(\.\d+)?-luna/, 0.1, 0.5],
  [/claude-fable/, 10, 50], [/claude-mythos/, 10, 50], [/claude-opus-5-5/, 4, 20], [/claude-opus/, 5, 25],
  [/claude-sonnet-5/, 2, 10], [/claude-sonnet/, 3, 15], [/claude-haiku-5/, 0.1, 0.5], [/claude-haiku/, 1, 5],
  [/gpt-4\.1-mini/, 0.4, 1.6], [/gpt-4\.1/, 2, 8], [/gpt-4o-mini/, 0.15, 0.6], [/gpt-4o/, 2.5, 10], [/gpt-5/, 1.25, 10], [/o[134]-?mini/, 1.1, 4.4],
];
const WINDOWS: [RegExp, number][] = [[/gpt-6|gpt-5\.[5-9]/, 1_050_000], [/claude-(fable|mythos|opus-[45]|sonnet-[45]|haiku-5)/, 1_000_000], [/claude/, 200_000], [/gpt-4\.1/, 1_000_000], [/gpt-5/, 400_000], [/gpt-4o|o[134]/, 128_000]];

export const priceOf = (model: string) => PRICES.find(([re]) => re.test(model));
export const contextWindow = (model: string) => WINDOWS.find(([re]) => re.test(model))?.[1] ?? 128_000;

/** Estimated dollars for a token split, or null when the model's price is unknown. */
/** Cached input is billed at roughly a tenth of the normal input price on both OpenAI and Anthropic; this is an estimate, not an invoice. */
export const CACHED_RATE = 0.1;
export function estimateCost(model: string, promptTokens: number, completionTokens: number, cachedTokens = 0): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const cached = Math.min(cachedTokens, promptTokens);
  return ((promptTokens - cached) * p[1] + cached * p[1] * CACHED_RATE + completionTokens * p[2]) / 1_000_000;
}
export const fmtCost = (c: number | null) => (c === null ? "" : c < 0.01 ? "<$0.01" : "$" + c.toFixed(2));
export const fmtTokens = (n: number) => (n >= 1_000_000 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k" : String(n));
export const fmtDuration = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

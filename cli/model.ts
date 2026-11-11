import { anthropic, effortsFor, gateFor, openai, rateLimited, type Model } from "../src/index.ts";
import { PROVIDERS, type Config } from "./config.ts";

/** One place for the UI to hear about rate limits, whichever model object hit them. */
let waitListener: ((ms: number, attempt: number, concurrency: number) => void) | undefined;
export const onRateLimitWait = (fn: typeof waitListener) => { waitListener = fn; };

/** Build the model for a config (shared by the menu and headless mode). */
export function createModel(cfg: Config, retries?: number, o: { cacheKey?: string; /** told when a rate limit makes calls wait */ onWait?: (ms: number, attempt: number, concurrency: number) => void } = {}): Model {
  // Every model built for the same endpoint and key shares one gate, so parallel subagents slow down together when the provider says 429.
  // A local server usually has one slot (llama.cpp's default): requests in parallel only queue there, and a second one can evict the first one's prefix cache.
  const local = cfg.provider === "ollama" || (cfg.provider === "custom" && !/api\.(openai|anthropic)\.com|openrouter\.ai/.test(cfg.baseUrl));
  const gate = gateFor(`${cfg.provider}|${cfg.baseUrl}|${(cfg.apiKey ?? "").slice(-6)}`, cfg.maxConcurrent ?? (local ? 1 : 4));
  return rateLimited(rawModel(cfg, retries, o), { gate, onWait: (ms, attempt, g) => { o.onWait?.(ms, attempt, g.max); waitListener?.(ms, attempt, g.max); } });
}
function rawModel(cfg: Config, retries: number | undefined, o: { cacheKey?: string }): Model {
  return cfg.provider === "anthropic"
    ? anthropic({ model: cfg.model, apiKey: cfg.apiKey, taskBudget: cfg.taskBudget, advisor: nativeAdvisor(cfg), effort: cfg.effort && !["none", "minimal"].includes(cfg.effort) ? (cfg.effort as "low" | "medium" | "high" | "xhigh" | "max") : undefined, baseUrl: cfg.baseUrl === PROVIDERS.anthropic.baseUrl ? undefined : cfg.baseUrl })
    : openai({
      model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, retries, api: cfg.api, promptCacheKey: o.cacheKey, compactAt: cfg.compactAt, externalRetry: true,
      effort: cfg.effort && effortsFor(cfg.model).includes(cfg.effort) ? cfg.effort : undefined,        // a value this model does not accept is never sent
    });
}

/**
 * The native Claude advisor for this config: only for a Claude main model whose `models.advisor` is also a Claude model on the same key.
 * (Any other pairing, such as a local executor with a Claude advisor, uses the generic advisor of the harness instead.)
 */
export function nativeAdvisor(cfg: Config): { model: string; maxUses?: number; maxTokens?: number; cap?: number; caching?: "5m" | "1h" } | undefined {
  const ref = cfg.models?.advisor; if (!ref || cfg.provider !== "anthropic") return undefined;
  const m = /^(?:anthropic[:/])?(claude-[\w.-]+)$/.exec(ref.trim()); if (!m) return undefined;
  const a = cfg.advisor ?? {};
  return { model: m[1], maxUses: a.maxUses ?? 3, maxTokens: a.maxTokens ?? 2048, cap: a.cap ?? 8, caching: a.caching };
}

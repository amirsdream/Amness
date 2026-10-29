import { anthropic, effortsFor, gateFor, openai, rateLimited, type Model } from "../src/index.ts";
import { PROVIDERS, type Config } from "./config.ts";

/** One place for the UI to hear about rate limits, whichever model object hit them. */
let waitListener: ((ms: number, attempt: number, concurrency: number) => void) | undefined;
export const onRateLimitWait = (fn: typeof waitListener) => { waitListener = fn; };

/** Build the model for a config (shared by the menu and headless mode). */
export function createModel(cfg: Config, retries?: number, o: { cacheKey?: string; /** told when a rate limit makes calls wait */ onWait?: (ms: number, attempt: number, concurrency: number) => void } = {}): Model {
  // Every model built for the same endpoint and key shares one gate, so parallel subagents slow down together when the provider says 429.
  const gate = gateFor(`${cfg.provider}|${cfg.baseUrl}|${(cfg.apiKey ?? "").slice(-6)}`, cfg.maxConcurrent ?? 4);
  return rateLimited(rawModel(cfg, retries, o), { gate, onWait: (ms, attempt, g) => { o.onWait?.(ms, attempt, g.max); waitListener?.(ms, attempt, g.max); } });
}
function rawModel(cfg: Config, retries: number | undefined, o: { cacheKey?: string }): Model {
  return cfg.provider === "anthropic"
    ? anthropic({ model: cfg.model, apiKey: cfg.apiKey, taskBudget: cfg.taskBudget, effort: cfg.effort && !["none", "minimal"].includes(cfg.effort) ? (cfg.effort as "low" | "medium" | "high" | "xhigh" | "max") : undefined, baseUrl: cfg.baseUrl === PROVIDERS.anthropic.baseUrl ? undefined : cfg.baseUrl })
    : openai({
      model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, retries, api: cfg.api, promptCacheKey: o.cacheKey, compactAt: cfg.compactAt, externalRetry: true,
      effort: cfg.effort && effortsFor(cfg.model).includes(cfg.effort) ? cfg.effort : undefined,        // a value this model does not accept is never sent
    });
}

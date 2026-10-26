import { anthropic, effortsFor, openai, type Model } from "../src/index.ts";
import { PROVIDERS, type Config } from "./config.ts";

/** Build the model for a config (shared by the menu and headless mode). */
export function createModel(cfg: Config, retries?: number, o: { cacheKey?: string } = {}): Model {
  return cfg.provider === "anthropic"
    ? anthropic({ model: cfg.model, apiKey: cfg.apiKey, effort: cfg.effort && !["none", "minimal"].includes(cfg.effort) ? (cfg.effort as "low" | "medium" | "high" | "xhigh" | "max") : undefined, baseUrl: cfg.baseUrl === PROVIDERS.anthropic.baseUrl ? undefined : cfg.baseUrl })
    : openai({
      model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, retries, api: cfg.api, promptCacheKey: o.cacheKey,
      effort: cfg.effort && effortsFor(cfg.model).includes(cfg.effort) ? cfg.effort : undefined,        // a value this model does not accept is never sent
    });
}

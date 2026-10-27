// Model routing helpers: roles that use different models (explore, compact, review), and a fallback chain that survives an overloaded or unavailable provider.
import type { Message, Model, ModelOpts, ToolSpec } from "./harness.ts";

export type Roles = Partial<Record<"explore" | "compact" | "review", Model>>;

/** Errors worth trying another model for: rate limits, overload, server errors, timeouts, and network failures (the adapters already retried the same model). */
export function isRetryable(e: unknown): boolean {
  const err = e as { status?: number; name?: string; message?: string; code?: string };
  if (err?.name === "AbortError") return false;
  if (typeof err?.status === "number") return err.status === 408 || err.status === 429 || err.status >= 500;
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|overloaded|HTTP (408|429|5\d\d))\b/i.test(`${err?.code ?? ""} ${err?.message ?? ""}`);
}

/**
 * Try `primary`; if it fails with a retryable error, answer from `fallback` instead (and say so through `onFallback`).
 * The fallback model sees the same messages; adapters ignore reasoning blobs that belong to another provider.
 */
export function withFallback(primary: Model, fallback: Model, onFallback?: (e: unknown) => void): Model {
  const m: Model = async (messages: Message[], tools: ToolSpec[], opts?: ModelOpts) => {
    try { return await primary(messages, tools, opts); }
    catch (e) { if (!isRetryable(e) || opts?.signal?.aborted) throw e; onFallback?.(e); return fallback(messages, tools, opts); }
  };
  m.appendOnly = primary.appendOnly || fallback.appendOnly;      // if either may be Claude, history must not be rewritten
  if (primary.api) m.api = primary.api;
  return m;
}

// Staying under a provider's requests-per-minute and tokens-per-minute limits when several agents (the lead, parallel explorers, the reviewer) share one API key.
// Follows the vendors' guidance (OpenAI rate-limit guide, Anthropic rate-limit docs): wait at least `Retry-After` plus random jitter, back off exponentially when it is missing,
// cap attempts and total wait, never retry quota or billing errors, and ramp traffic up gradually (Anthropic's "acceleration limits"). Concurrency follows AIMD, like TCP congestion
// control: halve on a 429, add one after a run of successes. One gate is shared by every model call in the process, so parallel subagents slow down together instead of each retrying alone.
import type { Message, Model, ModelOpts, ToolSpec } from "./harness.ts";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new DOMException("aborted", "AbortError"));
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms), onAbort = () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** "1s", "6m0s", "20ms", "1.5s" -> milliseconds (the format of x-ratelimit-reset-* headers). */
export function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g; let total = 0, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(s))) { any = true; total += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms"]; }
  return any ? total : undefined;
}
const header = (e: any, name: string): string | undefined => { const h = e?.headers; const v = typeof h?.get === "function" ? h.get(name) : h?.[name]; return v == null ? undefined : String(v); };
/** How long the server asked us to wait (Retry-After seconds or date, retry-after-ms, or "try again in 1.2s" in the message), if it said. */
export function retryAfterMs(e: any): number | undefined {
  if (typeof e?.retryAfterMs === "number") return e.retryAfterMs;
  const ms = header(e, "retry-after-ms"); if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = header(e, "retry-after"); if (ra) { if (Number.isFinite(Number(ra))) return Number(ra) * 1000; const d = Date.parse(ra); if (Number.isFinite(d)) return Math.max(0, d - Date.now()); }
  const m = /try again in ([\d.]+\s*(?:ms|s|m))/i.exec(String(e?.message ?? "")); return m ? parseDuration(m[1].replace(/\s+/g, "")) : undefined;
}
/** A 429 that waiting can fix. Quota, billing and spend-cap errors also arrive as 429 but never recover by retrying. */
export function isRateLimit(e: any): boolean {
  const msg = String(e?.message ?? "");
  if (/insufficient_quota|exceeded your current quota|billing|spend limit|usage limits|enforced_spend_limit/i.test(msg)) return false;
  return e?.status === 429 || /\bHTTP 429\b|rate.?limit/i.test(msg);
}

export class Gate {
  max: number; readonly ceiling: number; active = 0; pausedUntil = 0; private successes = 0; private waiters: (() => void)[] = []; limited = 0;
  constructor(o: { ceiling?: number; start?: number } = {}) { this.ceiling = Math.max(1, o.ceiling ?? 4); this.max = Math.min(this.ceiling, Math.max(1, o.start ?? 2)); }
  private wake() { const w = this.waiters.shift(); if (w) w(); }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const wait = this.pausedUntil - Date.now(); if (wait > 0) { await sleep(wait, signal); continue; }
      if (this.active < this.max) { this.active++; let done = false; return () => { if (done) return; done = true; this.active--; this.wake(); }; }
      await new Promise<void>((res, rej) => { const w = () => { signal?.removeEventListener("abort", ab); res(); }, ab = () => { this.waiters = this.waiters.filter((x) => x !== w); rej(new DOMException("aborted", "AbortError")); }; this.waiters.push(w); signal?.addEventListener("abort", ab, { once: true }); });
    }
  }
  success() { this.successes++; if (this.successes >= 3 && this.max < this.ceiling) { this.max++; this.successes = 0; this.wake(); } }
  /** A 429 happened: pause everyone, halve the concurrency, and say how long. */
  penalize(retryAfter: number | undefined, attempt: number): number {
    const backoff = Math.min(60_000, 1000 * 2 ** attempt), wait = Math.round((retryAfter ?? backoff) + Math.random() * Math.min(750, 100 + 0.25 * (retryAfter ?? backoff)));
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + wait); this.max = Math.max(1, Math.floor(this.max / 2)); this.successes = 0; this.limited++; return wait;
  }
}

const gates = new Map<string, Gate>();
/** The gate for one API endpoint and key: every model built for it shares it. */
export function gateFor(key: string, ceiling = 4): Gate { let g = gates.get(key); if (!g) gates.set(key, (g = new Gate({ ceiling }))); return g; }

export type RateLimitOptions = { gate?: Gate; /** attempts after the first (default 6) */ retries?: number; /** give up when asked to wait longer than this (default 2 minutes) */ maxWaitMs?: number; onWait?: (ms: number, attempt: number, gate: Gate) => void };
export function rateLimited(model: Model, o: RateLimitOptions = {}): Model {
  const gate = o.gate ?? new Gate(), retries = o.retries ?? 6, maxWait = o.maxWaitMs ?? 120_000;
  const call = (async (messages: Message[], tools: ToolSpec[], opts?: ModelOpts) => {
    for (let attempt = 0; ; attempt++) {
      const release = await gate.acquire(opts?.signal);
      try { const m = await model(messages, tools, opts); gate.success(); return m; }
      catch (e) {
        if (opts?.signal?.aborted || !isRateLimit(e) || attempt >= retries) throw e;
        const ra = retryAfterMs(e); if (ra !== undefined && ra > maxWait) throw e;
        const wait = gate.penalize(ra, attempt); o.onWait?.(wait, attempt + 1, gate);
      } finally { release(); }
    }
  }) as Model;
  return Object.assign(call, model);
}

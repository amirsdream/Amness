// An on-disk cache of model replies, for evals, replays and reruns: an identical request is answered from disk and costs nothing.
// It is off unless asked for (`--cache`). In a live chat every request differs from the one before, so it would never hit.
// Trials stay independent: the key is the request plus how many times this process has already sent that exact request, so trial 2 of a task gets its own stored reply, not trial 1's.
// The stored reply keeps the token counts of the original call, so numbers stay comparable between a fresh run and a cached one; `stats` says what really went to the model.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Model, ModelOpts, ToolSpec } from "./harness.ts";

export type RespCacheStats = { hits: number; fresh: number };

/** `salt` names everything outside the request that changes the answer (provider, model, base URL, effort, sampling). Different salt, different cache. */
export function cachedModel(model: Model, o: { dir: string; salt: string }): Model & { stats: RespCacheStats } {
  const stats: RespCacheStats = { hits: 0, fresh: 0 }, seenIn = new Map<string, number>();
  const wrapped = (async (msgs: Message[], specs: ToolSpec[], opts?: ModelOpts): Promise<Message> => {
    const body = JSON.stringify({ salt: o.salt, specs, msgs: msgs.map(({ usage: _u, ...m }) => m) }), base = createHash("sha256").update(body).digest("hex").slice(0, 32);
    const nth = seenIn.get(base) ?? 0; seenIn.set(base, nth + 1);
    const file = join(o.dir, `${base}-${nth}.json`);
    if (existsSync(file)) {
      try { const reply = JSON.parse(readFileSync(file, "utf8")) as Message; stats.hits++; if (reply.content) opts?.onText?.(reply.content); return reply; } catch { /* a damaged entry is a miss */ }
    }
    const reply = await model(msgs, specs, opts); stats.fresh++;
    try { mkdirSync(o.dir, { recursive: true }); writeFileSync(file, JSON.stringify(reply)); } catch { /* a read-only folder: run uncached */ }
    return reply;
  }) as Model & { stats: RespCacheStats };
  Object.assign(wrapped, model, { stats });
  return wrapped;
}

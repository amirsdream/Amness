// Deciding whether to rewrite old messages. A rewrite (blanking stale tool output, shrinking arguments) makes later requests smaller, but it changes the transcript from the first edited message onward,
// so the provider's prompt cache stops matching there and everything after that point is read again at the fresh price. Whether that pays depends on numbers the loop can measure:
//   saved   = tokens the rewrite removes (they would otherwise be carried, at the cached price, in every later request)
//   lost    = tokens from the first edited message to the end (read again at the fresh price, once)
//   later   = how many requests are still to come
// Rewrite when  saved × later × cachedPrice  >  lost × (1 − cachedPrice).  When the cache is already cold (idle gap longer than its lifetime) the loss is zero, so any saving pays.
// Measured with `amness replay`: on one recorded session, never rewriting cost 20% more at a 10% cached price, so rewriting does pay on average. Across 21 replayed sessions this rule changed the cost by -0.7% to +5.6% depending on how "requests still to come" is guessed, with no consistent sign, so it is OFF by default (`governRewrites`).
// Sources: arXiv 2610.34763 (masking cut prompt volume a third and raised uncached prefill sixfold when the cache was warm), arXiv 2508.21433 (masking halves cost).
import { estimateTokens } from "./context.ts";
import type { Message } from "./harness.ts";

export type RewriteContext = {
  /** requests the run is still expected to make */ later: number;
  /** cached input price as a share of fresh input (0.1 for most hosted providers) */ cachedPrice: number;
  /** the provider's cache has expired or never existed: nothing is lost by rewriting */ cold: boolean;
  /** requests made since the last rewrite */ since: number;
  /** fewest requests between two rewrites while the cache is warm */ minGap: number;
};
export type RewritePlan = { /** index of the first message that changes */ from: number; /** tokens removed */ saved: number; /** tokens the cache loses */ lost: number; /** message indexes to change */ indexes: number[] };

/** Does a rewrite that removes `saved` tokens and invalidates the cache for `lost` tokens pay for itself? */
export const rewritePays = (saved: number, lost: number, c: Pick<RewriteContext, "later" | "cachedPrice" | "cold">): boolean =>
  saved > 0 && (c.cold || saved * c.later * c.cachedPrice > lost * (1 - c.cachedPrice));

/** Requests still to come, guessed from the ones so far (a run that took n steps is likely to take about n more), capped by the step limit. */
export const requestsLeft = (step: number, max: number): number => Math.max(1, Math.min(max - step, Math.max(3, step)));

const same = (a: Message, b: Message) => a.content === b.content && JSON.stringify(a.tool_calls) === JSON.stringify(b.tool_calls);

/**
 * `trial` is a copy of `msgs` with a rewrite already applied to it. Pick the part of that rewrite worth keeping: the changes from some message `from` to the end, since the later the first change, the less cache is lost.
 * Returns undefined when no suffix pays (or the copy has a different length, which means whole turns were dropped: that is not a rewrite this function judges).
 */
export function planRewrite(msgs: Message[], trial: Message[], c: RewriteContext): RewritePlan | undefined {
  if (trial.length !== msgs.length) return undefined;
  const idx: number[] = []; msgs.forEach((m, i) => { if (!same(m, trial[i])) idx.push(i); });
  if (!idx.length) return undefined;
  if (!c.cold && c.since < c.minGap) return undefined;
  const size = msgs.map((m) => estimateTokens([m])), gain = idx.map((i) => Math.max(0, size[i] - estimateTokens([trial[i]])));
  const tail = new Array<number>(msgs.length + 1).fill(0); for (let i = msgs.length - 1; i >= 0; i--) tail[i] = tail[i + 1] + size[i];
  let best: RewritePlan | undefined, bestNet = 0, saved = 0;
  for (let j = idx.length - 1; j >= 0; j--) {                                                                  // from the newest change backwards: each step widens the suffix by one more change
    saved += gain[j]; const from = idx[j], lost = tail[from];
    const net = c.cold ? saved : saved * c.later * c.cachedPrice - lost * (1 - c.cachedPrice);
    if (rewritePays(saved, lost, c) && net > bestNet) { bestNet = net; best = { from, saved, lost, indexes: idx.slice(j) }; }
  }
  return best;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate, isRateLimit, parseDuration, rateLimited, retryAfterMs, type Message, type Model } from "../src/index.ts";

const ok: Message = { role: "assistant", content: "ok" };
const err429 = (extra: object = {}) => Object.assign(new Error("HTTP 429: rate limit reached"), { status: 429 }, extra);

test("durations and Retry-After are read the way the vendors send them", () => {
  assert.equal(parseDuration("6m0s"), 360000); assert.equal(parseDuration("1.5s"), 1500); assert.equal(parseDuration("20ms"), 20); assert.equal(parseDuration("soon"), undefined);
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "7" }) }), 7000); assert.equal(retryAfterMs({ headers: { "retry-after-ms": "250" } }), 250);
  assert.equal(retryAfterMs({ retryAfterMs: 90 }), 90); assert.equal(retryAfterMs(new Error("Rate limit reached. Please try again in 1.5s.")), 1500); assert.equal(retryAfterMs(new Error("boom")), undefined);
});
test("only recoverable 429s count: quota and spend-cap errors are not retried", () => {
  assert.ok(isRateLimit(err429())); assert.ok(isRateLimit(new Error("HTTP 429: slow down")));
  assert.ok(!isRateLimit(Object.assign(new Error("You exceeded your current quota"), { status: 429 }))); assert.ok(!isRateLimit(Object.assign(new Error("enforced_spend_limit_reached"), { status: 429 })));
  assert.ok(!isRateLimit(Object.assign(new Error("HTTP 500"), { status: 500 })));
});
test("a 429 pauses every caller, halves the concurrency, honours Retry-After, then the call succeeds", async () => {
  const gate = new Gate({ ceiling: 4, start: 4 }); let calls = 0; const waits: number[] = [];
  const model: Model = (async () => { if (++calls === 1) throw err429({ retryAfterMs: 80 }); return ok; }) as Model;
  const t0 = Date.now(), r = await rateLimited(model, { gate, onWait: (ms) => waits.push(ms) })([], []);
  assert.equal(r.content, "ok"); assert.equal(calls, 2); assert.ok(Date.now() - t0 >= 75, "waited at least Retry-After"); assert.equal(gate.max, 2); assert.equal(waits.length, 1); assert.ok(waits[0] >= 80 && waits[0] < 900);
});
test("concurrency never exceeds the gate, a limited call does not block others past the pause, and successes ramp back up", async () => {
  const gate = new Gate({ ceiling: 3, start: 1 }); let live = 0, peak = 0;
  const model: Model = (async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return ok; }) as Model;
  const m = rateLimited(model, { gate }); await Promise.all(Array.from({ length: 12 }, () => m([], [])));
  assert.ok(peak <= 3, `peak ${peak}`); assert.equal(gate.max, 3);                                    // 12 successes raised it from 1 to the ceiling
});
test("gives up after the retry budget, on abort, and when asked to wait too long", async () => {
  const always: Model = (async () => { throw err429({ retryAfterMs: 1 }); }) as Model;
  await assert.rejects(rateLimited(always, { gate: new Gate(), retries: 2 })([], []), /429/);
  await assert.rejects(rateLimited((async () => { throw err429({ retryAfterMs: 600_000 }); }) as Model, { gate: new Gate(), maxWaitMs: 1000 })([], []), /429/);
  const ac = new AbortController(); let n = 0; const slow: Model = (async () => { if (++n === 1) throw err429({ retryAfterMs: 5000 }); return ok; }) as Model;
  const p = rateLimited(slow, { gate: new Gate() })([], [], { signal: ac.signal }); setTimeout(() => ac.abort(), 30); await assert.rejects(p, /abort/i);
  const quota: Model = (async () => { throw Object.assign(new Error("insufficient_quota"), { status: 429 }); }) as Model; let q = 0;
  await assert.rejects(rateLimited((async (...a: any[]) => { q++; return (quota as any)(...a); }) as Model, { gate: new Gate() })([], []), /quota/); assert.equal(q, 1);
});
test("the wrapper keeps the model's flags (appendOnly) so cache handling still works", () => {
  const m: Model = (async () => ok) as Model; m.appendOnly = true; assert.equal(rateLimited(m).appendOnly, true);
});

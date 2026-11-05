import { test } from "node:test";
import assert from "node:assert/strict";
import { planRewrite, requestsLeft, rewritePays, type RewriteContext } from "../src/rewrite.ts";
import { replayUnits, type ReplayCost } from "../src/replay.ts";
import type { Message } from "../src/harness.ts";

const ctx: RewriteContext = { later: 10, cachedPrice: 0.1, cold: false, since: 99, minGap: 3 };
const big = (n: number) => "x".repeat(n * 4);
const tool = (id: string, n: number): Message => ({ role: "tool", tool_call_id: id, content: big(n) });
const history = (): Message[] => [{ role: "system", content: "s" }, tool("a", 1500), tool("b", 6000), tool("c", 3000), { role: "user", content: "go" }];
const stub = (m: Message): Message => ({ ...m, content: "[old output elided]" });

test("rewritePays: pays when the saved tokens carried by later requests outweigh the cache that is lost", () => {
  assert.equal(rewritePays(5000, 8000, { later: 10, cachedPrice: 0.1, cold: false }), false);   // 5000 × 10 × 0.1 = 5000 < 8000 × 0.9
  assert.equal(rewritePays(5000, 8000, { later: 20, cachedPrice: 0.1, cold: false }), true);    // 10000 > 7200
  assert.equal(rewritePays(5000, 99999, { later: 1, cachedPrice: 0.1, cold: true }), true);     // a cold cache loses nothing
  assert.equal(rewritePays(0, 0, { later: 10, cachedPrice: 0.1, cold: true }), false);          // nothing to save
});

test("planRewrite: keeps only the suffix of changes that pays, so the early cache stays", () => {
  const msgs = history(), trial = msgs.map((m, i) => (i === 1 || i === 3 ? stub(m) : { ...m }));
  // changing message 1 as well would lose the cache for 1..4 (about 12000 tokens) to save 1500 more; changing only 3 loses 3000 to save 3000
  const p = planRewrite(msgs, trial, { ...ctx, later: 10 });
  assert.ok(p); assert.deepEqual(p!.indexes, [3]); assert.ok(p!.saved > 3300 && p!.lost < 3500);
  assert.equal(planRewrite(msgs, trial, { ...ctx, later: 1 }), undefined);                       // a run about to end: nothing pays
  assert.deepEqual(planRewrite(msgs, trial, { ...ctx, later: 40 })!.indexes, [3]);               // even a long run does not extend the rewrite back over the 6000-token message
});

test("planRewrite: a cold cache takes the whole rewrite; a recent rewrite makes a warm one wait; dropped turns are not judged", () => {
  const msgs = history(), trial = msgs.map((m, i) => (i === 1 || i === 3 ? stub(m) : { ...m }));
  assert.deepEqual(planRewrite(msgs, trial, { ...ctx, later: 1, cold: true })!.indexes, [1, 3]);
  assert.equal(planRewrite(msgs, trial, { ...ctx, later: 40, since: 1 }), undefined);
  assert.equal(planRewrite(msgs, trial.slice(1), { ...ctx, later: 40 }), undefined);
  assert.equal(planRewrite(msgs, msgs.map((m) => ({ ...m })), { ...ctx, later: 40 }), undefined);  // nothing changed
});

test("requestsLeft: guessed from the steps so far, capped by the step limit", () => {
  assert.equal(requestsLeft(0, 30), 3); assert.equal(requestsLeft(10, 30), 10); assert.equal(requestsLeft(25, 30), 5); assert.equal(requestsLeft(29, 30), 1);
});

test("replayUnits: cached tokens count at the cached price", () => {
  const c: ReplayCost = { requests: 3, prompt: 1000, cached: 800 };
  assert.equal(replayUnits(c, 0.1), 280); assert.equal(replayUnits(c, 0.5), 600);
});

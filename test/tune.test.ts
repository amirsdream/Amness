import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { split, tune, type Case, type Profile, type Step, type Variant } from "../src/index.ts";

const cases = (n: number, check: Case["check"]): Case[] => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, files: {}, task: "x", check }));
const marker = async (d: string) => readFileSync(`${d}/r`, "utf8") === "yes";
const variant = (fail: (off: string[], c: Case) => boolean, tokens: (off: string[]) => number) => (p: Profile, name: string): Variant => ({ name, run: async (c, dir) => {
  const off = p.off ?? []; writeFileSync(`${dir}/r`, fail(off, c) ? "no" : "yes"); return { text: "", steps: 1, tokens: tokens(off), events: {} };
} });

test("split is deterministic and keeps at least one task on each side", () => {
  const a = split(cases(6, marker), 0.34, 3), b = split(cases(6, marker), 0.34, 3);
  assert.deepEqual(a.heldOut.map((c) => c.name), b.heldOut.map((c) => c.name)); assert.equal(a.train.length + a.heldOut.length, 6); assert.ok(a.heldOut.length >= 1);
  assert.equal(split(cases(1, marker)).heldOut.length, 0);
});

test("keeps a change that is cheaper and harmless, rejects one that breaks tasks", async () => {
  const r = await tune({ cases: cases(6, marker), makeVariant: variant((off) => off.includes("loop"), (off) => (off.includes("nudge") ? 700 : 1000)), trials: 1, guards: ["nudge", "loop"], seed: 2 });
  assert.deepEqual(r.accepted, ["switch off nudge"]); assert.deepEqual(r.profile.off, ["nudge"]);
  assert.ok(r.steps.some((s: Step) => s.change === "switch off loop" && !s.accepted));
  assert.ok(r.steps.some((s: Step) => s.stage === "heldout" && s.accepted));
});

test("a change that only looks good on the training tasks is rolled back by the held-out gate", async () => {
  const cs = cases(6, marker), held = new Set(split(cs, 0.34, 5).heldOut.map((c) => c.name));
  const r = await tune({ cases: cs, makeVariant: variant((off, c) => off.includes("nudge") && held.has(c.name), (off) => (off.includes("nudge") ? 600 : 1000)), trials: 1, guards: ["nudge"], seed: 5 });
  assert.deepEqual(r.accepted, []); assert.equal(r.profile.off, undefined);
  assert.ok(r.steps.some((s: Step) => s.stage === "train" && s.accepted)); assert.ok(r.steps.some((s: Step) => s.stage === "heldout" && !s.accepted));
});

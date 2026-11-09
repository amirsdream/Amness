import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTune, split, tune, tuneModels, writeProfile, type Case, type Profile, type Step, type Variant } from "../src/index.ts";

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

test("tune v2: each model is tuned on its own; a change goes only into the profile of the model it held up for; predictions are checked; redact is never tried", async () => {
  const steps: Step[] = [];
  // "local" fails when nudge is off; "cloud" does fine without it and costs less: nudge off should be kept for cloud only.
  const { results, shared } = await tuneModels({ cases: cases(6, marker), trials: 1, guards: ["nudge", "redact"], seed: 2, onStep: (s) => steps.push(s),
    models: [{ name: "local", makeVariant: variant((off) => off.includes("nudge"), () => 1000) }, { name: "cloud", makeVariant: variant(() => false, (off) => (off.includes("nudge") ? 600 : 1000)) }] });
  assert.deepEqual(results.local.accepted, []); assert.deepEqual(results.cloud.accepted, ["switch off nudge"]); assert.deepEqual(shared, []);
  assert.ok(!steps.some((s) => /redact/.test(s.change)), "safety guards are never candidates");
  const cloudTrain = steps.find((s) => s.model === "cloud" && s.stage === "train")!;
  assert.equal(cloudTrain.predicted, "the same pass rate with fewer tokens per solved task"); assert.equal(cloudTrain.held, true);
  assert.equal(steps.find((s) => s.model === "local" && s.stage === "train")!.held, false);
});

test("tune v2: requiring tool calls and step limits are candidates too; writeProfile merges into one model's entry and keeps the rest of the file", async () => {
  const r = await tune({ cases: cases(6, marker), trials: 1, guards: [], toolChoice: true, maxSteps: [20], seed: 2,
    makeVariant: (p, name) => ({ name, run: async (c, dir) => { writeFileSync(`${dir}/r`, p.toolChoice === "required" || Number(c.name.slice(1)) % 2 === 0 ? "yes" : "no"); return { text: "", steps: 1, tokens: p.maxSteps === 20 ? 2000 : 1000, events: {} }; } }) });
  assert.ok(r.accepted.includes("toolChoice = required")); assert.ok(!r.accepted.includes("maxSteps = 20"));   // more passes: kept; more tokens for nothing: dropped
  const f = `${mkdtempSync(join(tmpdir(), "amness-tune-"))}/profile.json`;
  writeFileSync(f, JSON.stringify({ default: { maxSteps: 50 }, models: { other: { off: ["nudge"] }, qwen: { maxSteps: 30 } } }));
  writeProfile(f, "qwen", { toolChoice: "required" });
  const j = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(j.default, { maxSteps: 50 }); assert.deepEqual(j.models.other, { off: ["nudge"] });
  assert.equal(j.models.qwen.maxSteps, 30); assert.equal(j.models.qwen.toolChoice, "required");
  assert.match(readFileSync(archiveTune(join(f, "..", "tune"), { ok: 1 }), "utf8"), /"ok": 1/);
});

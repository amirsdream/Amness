import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, loadProfile, recommend, type Row } from "../src/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "amness-pf-"));
test("profile: patterns match model names, the project overrides the user, guards accumulate, bad files are a clear error", () => {
  const p = dir(), u = dir(); mkdirSync(join(p, ".amness"));
  writeFileSync(join(u, "profile.json"), JSON.stringify({ default: { maxSteps: 40 }, models: { "gpt-*": { off: ["nudge"] }, "claude-*": { off: ["loop"] } } }));
  writeFileSync(join(p, ".amness", "profile.json"), JSON.stringify({ models: { "gpt-6*": { off: ["wrapup"], stagnationTurns: 5, maxSteps: 25 } } }));
  const gpt = loadProfile(p, "gpt-6.1-sol", { userDir: u }).profile; assert.deepEqual([gpt.off?.sort(), gpt.stagnationTurns, gpt.maxSteps], [["nudge", "wrapup"], 5, 25]);
  assert.deepEqual(loadProfile(p, "claude-opus-5-5", { userDir: u }).profile.off, ["loop"]);
  assert.deepEqual(loadProfile(p, "llama3", { userDir: u }).profile, { maxSteps: 40, off: [] });
  writeFileSync(join(p, ".amness", "profile.json"), JSON.stringify({ default: { off: ["not-a-guard"] } })); assert.throws(() => loadProfile(p, "x", { userDir: u }), /"off" must be a list of guards/);
  writeFileSync(join(p, ".amness", "profile.json"), JSON.stringify({ default: { maxSteps: -1 } })); assert.throws(() => loadProfile(p, "x", { userDir: u }), /non-negative/);
});

const row = (variant: string, c: number, t: number, pass: boolean, tokens: number): Row => ({ case: "t" + c, variant, trial: t, pass, steps: 1, tokens, ms: 1 });
test("recommend: remove only what the data supports; load-bearing guards stay; weak evidence is called out", () => {
  const rows: Row[] = [];
  for (let c = 0; c < 40; c++) for (let t = 0; t < 3; t++) {
    rows.push(row("full", c, t, c < 28, 1000));
    rows.push(row("full-nudge", c, t, c < 28, 800));                    // same pass rate, cheaper: removable
    rows.push(row("full-ledger", c, t, c < 14, 1000));                   // loses half the tasks: load-bearing
    rows.push(row("full-loop", c, t, c < 28 || (c < 31 && t === 0), 1000));  // maybe slightly better, not significant
    rows.push(row("full-wrapup", c, t, c < 28, 1000));                  // no effect, no saving: stays
  }
  const r = recommend(analyze(rows, { baseline: "full" })), by = (g: string) => r.verdicts.find((v) => v.guard === g)!;
  assert.equal(by("nudge").action, "remove"); assert.match(by("nudge").why, /does not hurt[\s\S]*lowers tokens per solved task by 286/);
  assert.equal(by("ledger").action, "keep"); assert.match(by("ledger").why, /removing it loses 35 pts/);
  assert.equal(by("wrapup").action, "undecided"); assert.notEqual(by("loop").action, "keep");
  assert.deepEqual(r.profile.off, ["nudge"]); assert.match(r.strength, /40 tasks × 3 trial/);
  const few = recommend(analyze(rows.filter((x) => Number(x.case.slice(1)) < 4), { baseline: "full" })); assert.match(few.strength, /weak evidence/);
});

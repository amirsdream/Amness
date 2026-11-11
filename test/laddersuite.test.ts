import { test } from "node:test";
import assert from "node:assert/strict";
import { selfTest, type Row } from "../src/index.ts";
import { ladderCases, ladderVerdict } from "../src/laddercases.ts";

test("the qualification ladder suite is sound: every level's check fails on the starting files and passes with the reference solution", async () => {
  const r = await selfTest(ladderCases);
  assert.deepEqual(r.filter((x) => !x.ok), []); assert.equal(r.length, 5);
});

test("ladderVerdict: a level counts only when it and every level below passed in every trial", () => {
  const row = (c: string, pass: boolean, variant = "full", trial = 0): Row => ({ case: c, variant, trial, pass, steps: 1, tokens: 1, ms: 1 });
  const names = ladderCases.map((c) => c.name);
  assert.deepEqual(ladderVerdict(names.map((c) => row(c, true)), "full"), { level: 5, roles: ["compact", "quarantine", "advisor", "explore", "review", "approve", "main", "edit"] });
  const v = ladderVerdict([...names.map((c) => row(c, true)), row("L3-branch-on-result", false, "full", 1)], "full");
  assert.equal(v.level, 2); assert.deepEqual(v.roles, ["compact", "quarantine", "advisor"]); assert.equal(v.failed, "L3-branch-on-result");
  assert.equal(ladderVerdict([row("L1-single-read", false)], "full").level, 0);
});

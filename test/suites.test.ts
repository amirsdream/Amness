import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, evaluate, formatReport, leakAudit, loadSuite, suiteToCases, type Variant } from "../src/index.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString().trim();
function upstream() {                // a tiny "upstream" repository with a bug, and the patches a benchmark instance would carry
  const d = mkdtempSync(join(tmpdir(), "amness-up-")); git(d, "init", "-q");
  writeFileSync(join(d, "calc.js"), "exports.add = (a, b) => {\n  return a - b; // bug\n};\n"); git(d, "add", "."); git(d, "commit", "-qm", "base");
  const base = git(d, "rev-parse", "HEAD");
  const gold = "--- a/calc.js\n+++ b/calc.js\n@@ -1,3 +1,3 @@\n exports.add = (a, b) => {\n-  return a - b; // bug\n+  return a + b; // the actual addition fixed here\n };\n";
  const testPatch = "--- /dev/null\n+++ b/t.js\n@@ -0,0 +1,2 @@\n+const a = require('assert'); const { add } = require('./calc');\n+a.equal(add(2, 3), 5); console.log('ok');\n";
  return { d, base, gold, testPatch };
}
const jsonl = (rows: object[]) => { const f = join(mkdtempSync(join(tmpdir(), "amness-su-")), "s.jsonl"); writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return f; };

test("suite: SWE-bench field names load (JSON-string test lists, owner/name repos); a malformed row is a clear error", () => {
  const f = jsonl([{ instance_id: "a__b-1", repo: "owner/name", base_commit: "abc", problem_statement: "it breaks", FAIL_TO_PASS: '["t::one","t::two"]', PASS_TO_PASS: "[]", test_patch: "x", patch: "y" }]);
  const [i] = loadSuite(f); assert.deepEqual([i.id, i.repo, i.failToPass, i.passToPass], ["a__b-1", "https://github.com/owner/name.git", ["t::one", "t::two"], []]);
  assert.throws(() => loadSuite(jsonl([{ instance_id: "x" }])), /needs instance_id, repo, base_commit and problem_statement/);
});

test("suite: an instance is cloned at its base commit, the agent edits, hidden tests are applied only afterwards; fixing passes, doing nothing fails", async () => {
  const u = upstream(), f = jsonl([{ instance_id: "calc-1", repo: u.d, base_commit: u.base, problem_statement: "add() subtracts instead of adding", test_patch: u.testPatch, patch: u.gold, FAIL_TO_PASS: ["t.js"] }]);
  const cases = suiteToCases(loadSuite(f), { testCmd: "node {tests}" });
  assert.match(cases[0].task, /add\(\) subtracts[\s\S]*Do not modify existing tests/);
  let sawTest = true;
  const fixer: Variant = { name: "fixer", async run(_c, dir) { sawTest = (await import("node:fs")).existsSync(join(dir, "t.js")); writeFileSync(join(dir, "calc.js"), "exports.add = (a, b) => a + b;\n"); return { text: "", steps: 1, tokens: 10 }; } };
  const lazy: Variant = { name: "lazy", async run() { return { text: "", steps: 1, tokens: 5 }; } };
  const { rows } = await evaluate(cases, [fixer, lazy], { trials: 1 });
  assert.equal(sawTest, false);                                                   // the hidden tests were not in the workspace while the agent worked
  assert.deepEqual(rows.map((r) => [r.variant, r.pass, r.excluded]), [["fixer", true, undefined], ["lazy", false, undefined]]);
});

test("suite: an instance that cannot be prepared is excluded and listed in the ledger, never counted as a failure", async () => {
  const u = upstream(), f = jsonl([{ instance_id: "good", repo: u.d, base_commit: u.base, problem_statement: "p", test_patch: u.testPatch, FAIL_TO_PASS: ["t.js"] }, { instance_id: "bad-commit", repo: u.d, base_commit: "deadbeefdeadbeef", problem_statement: "p", FAIL_TO_PASS: ["t.js"] }]);
  const v: Variant = { name: "v", async run(_c, dir) { writeFileSync(join(dir, "calc.js"), "exports.add = (a, b) => a + b;\n"); return { text: "", steps: 1, tokens: 1 }; } };
  const { rows, analysis } = await evaluate(suiteToCases(loadSuite(f), { testCmd: "node {tests}" }), [v], { trials: 2 });
  assert.equal(rows.filter((r) => r.excluded).length, 2); assert.equal(analysis.stats[0].tasks, 1); assert.equal(analysis.stats[0].passRate, 1);       // only the good instance counts
  assert.deepEqual(analysis.excluded.map((x) => x.case), ["bad-commit", "bad-commit"]);
  const text = formatReport(analysis); assert.match(text, /exclusion ledger: 2 run\(s\) could not be set up and are NOT counted/); assert.match(text, /bad-commit \/ v:/);
});

test("audit: a fix leaked into the problem statement, a fix already in the base, and a missing base commit are all caught; a clean instance passes", async () => {
  const u = upstream(), clean = { id: "clean", repo: u.d, baseCommit: u.base, problem: "add() subtracts instead of adding", goldPatch: u.gold, failToPass: ["t.js"], passToPass: [] };
  const leaky = { ...clean, id: "leaky", problem: "Change it so that it reads: return a + b; // the actual addition fixed here" };
  const missing = { ...clean, id: "missing", baseCommit: "0000000000000000000000000000000000000000" };
  const found = await leakAudit([clean, leaky, missing]);
  assert.deepEqual(found.map((l) => l.id).sort(), ["leaky", "missing"]); assert.match(found.find((l) => l.id === "leaky")!.problem, /problem statement contains 1 line/);
  assert.match(found.find((l) => l.id === "missing")!.problem, /cannot check out the base commit/);
});

test("report: the bootstrap seed makes intervals reproducible", () => {
  const rows = Array.from({ length: 6 }, (_, t) => ["a", "b"].map((v) => ({ case: "t" + t, variant: v, trial: 0, pass: v === "a" ? t < 5 : t < 2, steps: 1, tokens: 1, ms: 1 }))).flat();
  assert.deepEqual(analyze(rows, { seed: 5 }).comparisons[0].ci, analyze(rows, { seed: 5 }).comparisons[0].ci);
});

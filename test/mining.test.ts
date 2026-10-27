import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseFromWorkspace, clusterFailures, formatMining, loadCases, readFailures, selfTest } from "../src/index.ts";

const line = (o: object) => JSON.stringify({ t: "x", ms: 1, ...o });
function traces() {
  const d = mkdtempSync(join(tmpdir(), "amness-mn-")); mkdirSync(join(d, "traces"));
  const sess = (name: string, ls: object[]) => writeFileSync(join(d, "traces", name + ".jsonl"), ls.map(line).join("\n") + "\n");
  const run = (task: string) => ({ kind: "run", messages: [{ role: "system", content: "s" }, { role: "user", content: task + "\n\n## Memory\nnotes" }] });
  sess("s1", [run("fix the date parser"), { kind: "turn", prompt: 100, completion: 10, cached: 0 }, { kind: "rejected", detail: "`npm test` failed:\n3 failing in /work/app/src/date.test.ts" }, { kind: "turn", prompt: 150, completion: 10, cached: 100 }, { kind: "loop", detail: 'sh{"cmd":"npm test"}' }, { kind: "turn", prompt: 200, completion: 5, cached: 150 }, { kind: "finish", summary: "ok" }]);
  sess("s2", [run("add pagination"), { kind: "turn", prompt: 100, completion: 10, cached: 0 }, { kind: "rejected", detail: "`npm test` failed:\n5 failing in /work/other/src/page.test.ts" }, { kind: "tool", ok: false, result: "ERROR: path escapes the workspace: ../x" }, { kind: "aborted", detail: "interrupted" }]);
  sess("s3", [{ kind: "turn", prompt: 10, completion: 1, cached: 0 }, { kind: "assistant", chars: 5 }]);
  writeFileSync(join(d, "traces", "bad.jsonl"), "not json\n{\"kind\":\"turn\"\n");
  return join(d, "traces");
}

test("mining: failures are read from traces; numbers and paths are normalised so the same problem clusters; interrupts are not defects", () => {
  const dir = traces(), { failures, traces: summaries } = readFailures(dir);
  assert.equal(summaries.length, 4); assert.deepEqual(summaries.find((s) => s.session === "s1")!, { file: join(dir, "s1.jsonl"), session: "s1", task: "fix the date parser", turns: 3, tokens: 475, cached: 250, prompt: 450, tools: 0, finished: true, failures: 2 });
  assert.ok(!failures.some((f) => f.category === "interrupted by the user"));
  const c = clusterFailures(failures); assert.equal(c[0].count, 2); assert.equal(c[0].sessions, 2); assert.match(c[0].signature, /^finish rejected: `…` failed: N failing in <path>$/);
  assert.ok(c.some((x) => x.category === "stuck in a loop") && c.some((x) => x.category === "tool error"));
});

test("mining: the report names patterns, example sessions and the way to keep a failure from returning", () => {
  const r = formatMining(traces()); assert.match(r, /4 session\(s\), 1 finished a task/); assert.match(r, /2×  finish rejected: `…` failed: N failing in <path>  \(2 sessions\)/); assert.match(r, /e\.g\. s1 turn 1: "fix the date parser"/); assert.match(r, /sessions with the most trouble/); assert.match(r, /amness traces --case/);
  assert.match(formatMining(join(tmpdir(), "no-such-dir-xyz")), /no traces in/);
});

test("mining: a repo becomes an eval task from git HEAD (not the working tree), loadable and runnable by the eval machinery", async () => {
  const d = mkdtempSync(join(tmpdir(), "amness-mc-")), git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, stdio: "pipe" });
  git("init", "-q"); writeFileSync(join(d, "a.js"), "exports.f = () => 1;\n"); writeFileSync(join(d, "test.js"), "process.exit(require('./a').f() === 2 ? 0 : 1)\n"); mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules", "x.js"), "x");
  git("add", "a.js", "test.js"); git("commit", "-qm", "init"); writeFileSync(join(d, "a.js"), "exports.f = () => 999; // uncommitted\n");
  const r = caseFromWorkspace(d, { name: "f returns 2!", task: "make f return 2", check: "node test.js", verify: "node test.js" });
  assert.match(r.path, /f-returns-2-\.json$/); assert.equal(r.files, 2);
  const j = JSON.parse(readFileSync(r.path, "utf8")); assert.equal(j.files["a.js"], "exports.f = () => 1;\n"); assert.ok(!("node_modules/x.js" in j.files));
  const cases = loadCases(join(d, ".amness", "evals", "cases")); assert.equal(cases[0].task, "make f return 2");
  const st = await selfTest(cases); assert.equal(st[0].ok, true); assert.match(st[0].why!, /no reference solution/);          // the check fails on the starting files, as it must
});

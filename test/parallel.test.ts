import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestOfN, parallelParts } from "../src/index.ts";

function repo(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "amness-par-")); const g = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c); g("add", "-A"); g("commit", "-qm", "init"); return d;
}
const VERIFY = `node -e "process.exit(require('fs').readFileSync('v.txt','utf8').includes('ok')?0:1)"`;

test("bestOfN escalates: stops at the first passing attempt and applies only its diff", async () => {
  const d = repo({ "v.txt": "bad\n" }); let calls = 0;
  const r = await bestOfN({ repo: d, n: 4, verify: VERIFY, apply: true, attempt: async (dir, i) => { calls++; writeFileSync(join(dir, "v.txt"), i === 1 ? "ok\n" : "still bad\n"); return { tokens: 100 }; } });
  assert.equal(calls, 2); assert.equal(r.winner?.index, 1); assert.equal(r.tokens, 200); assert.equal(r.applied, true);
  assert.equal(readFileSync(join(d, "v.txt"), "utf8"), "ok\n");
});

test("attempts do not interfere, and the extra checks decide between passing candidates", async () => {
  const d = repo({ "v.txt": "bad\n" });
  const r = await bestOfN({ repo: d, n: 3, parallel: true, verify: VERIFY, extraChecks: ["grep -q strong v.txt"],
    attempt: async (dir, i) => { writeFileSync(join(dir, "v.txt"), i === 2 ? "ok strong\n" : "ok\n"); writeFileSync(join(dir, `own${i}.txt`), "x"); return { tokens: 10 }; } });
  assert.equal(r.candidates.length, 3); assert.equal(r.winner?.index, 2); assert.equal(readFileSync(join(d, "v.txt"), "utf8"), "bad\n");           // main tree untouched without apply
  assert.ok(r.candidates.every((c) => c.diff.includes(`own${c.index}.txt`) && !c.diff.includes(`own${(c.index + 1) % 3}.txt`)));
});

test("the token cap stops new attempts, and no passing candidate means no winner", async () => {
  const d = repo({ "v.txt": "bad\n" });
  const r = await bestOfN({ repo: d, n: 5, verify: VERIFY, maxTokens: 250, attempt: async (dir) => { writeFileSync(join(dir, "v.txt"), "nope\n"); return { tokens: 100 }; } });
  assert.equal(r.candidates.length, 3); assert.equal(r.stoppedForBudget, true); assert.equal(r.winner, undefined);
});

test("parallel parts merge through verify; a conflicting or verify-breaking part is reverted and reported", async () => {
  const d = repo({ "a.txt": "a\n", "b.txt": "b\n", "shared.txt": "base\n" });
  const verify = `node -e "process.exit(require('fs').existsSync('POISON')?1:0)"`;
  const edits: Record<string, Record<string, string>> = { A: { "a.txt": "A\n", "shared.txt": "from A\n" }, B: { "b.txt": "B\n" }, C: { "shared.txt": "from C\n" }, D: { "POISON": "x" } };
  const { results } = await parallelParts({ repo: d, verify, parts: Object.keys(edits).map((name) => ({ name, task: name })),
    attempt: async (p, dir) => { for (const [f, c] of Object.entries(edits[p.name])) writeFileSync(join(dir, f), c); return { tokens: 5 }; } });
  const by = Object.fromEntries(results.map((r) => [r.part.name, r.status]));
  // each part passed verify in isolation except D (which writes POISON, so it fails in its own worktree)
  assert.deepEqual(by, { A: "merged", B: "merged", C: "conflict", D: "failed-verify" });
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "A\n"); assert.equal(readFileSync(join(d, "shared.txt"), "utf8"), "from A\n"); assert.equal(existsSync(join(d, "POISON")), false);
});

test("two parts that pass alone but break verify together: the second is reverted", async () => {
  const d = repo({ "x.txt": "x\n" });
  const verify = `node -e "const f=require('fs');process.exit(f.existsSync('p1')&&f.existsSync('p2')?1:0)"`;
  const { results } = await parallelParts({ repo: d, verify, parts: [{ name: "one", task: "" }, { name: "two", task: "" }], attempt: async (p, dir) => { writeFileSync(join(dir, p.name === "one" ? "p1" : "p2"), "1"); return {}; } });
  assert.deepEqual(results.map((r) => r.status), ["merged", "broke-verify"]); assert.equal(existsSync(join(d, "p2")), false); assert.ok(existsSync(join(d, "p1")));
});

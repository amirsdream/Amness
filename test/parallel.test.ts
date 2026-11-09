import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestOfN, modelJudge, parallelParts, rolloutSummary, tournament, withEarlier, type Model } from "../src/index.ts";

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

test("tournament: small groups, winners meet again; a bad pick keeps the first of its group", async () => {
  const groups: number[][] = [];
  const best = await tournament([3, 9, 1, 7, 4, 8, 2], async (g) => { groups.push(g); return g.indexOf(Math.max(...g)); }, 3);
  assert.equal(best, 9); assert.deepEqual(groups, [[3, 9, 1], [7, 4, 8], [9, 8, 2]]);
  assert.equal(await tournament([5, 6], async () => 42), 5);
  assert.equal(await tournament([], async () => 0), undefined);
});

test("bestOfN: a retry starts from what the failed attempt did (its summary and verify output); a judge picks among passing parallel attempts", async () => {
  let d = repo({ "v.txt": "bad\n" }); const seen: string[][] = [];
  const r = await bestOfN({ repo: d, n: 3, verify: VERIFY, attempt: async (dir, i, earlier) => { seen.push(earlier); writeFileSync(join(dir, "v.txt"), i === 0 ? "nope\n" : "ok\n"); return { tokens: 1, summary: i === 0 ? "I tried nope" : "fixed" }; } });
  assert.equal(r.winner?.index, 1); assert.deepEqual(seen[0], []);
  assert.match(seen[1][0], /Attempt 1: failed verify[\s\S]*Changed: v\.txt \(\+1 -1\)[\s\S]*It said: I tried nope[\s\S]*Verify output \(end\):[\s\S]*exit=1/);
  assert.match(withEarlier("fix it", seen[1]), /^fix it\n\n## Earlier attempts at this task failed verification[\s\S]*I tried nope/);
  d = repo({ "v.txt": "bad\n" }); const asked: number[] = [];
  const p = await bestOfN({ repo: d, n: 3, parallel: true, verify: VERIFY, judge: async (g) => { asked.push(g.length); return g.findIndex((c) => c.summary === "the good one"); },
    attempt: async (dir, i) => { writeFileSync(join(dir, "v.txt"), "ok" + "!".repeat(i) + "\n"); return { tokens: 1, summary: i === 2 ? "the good one" : "meh" }; } });
  assert.equal(p.winner?.index, 2); assert.deepEqual(asked, [3]); assert.match(rolloutSummary(p.winner!), /^Attempt 3: passed verify/);
});

test("modelJudge: shows the task, each candidate's summary and diff, and reads the number back", async () => {
  let prompt = "";
  const model: Model = async (m) => { prompt = m.at(-1)!.content!; return { role: "assistant", content: "Candidate 2 is best." }; };
  const c = (i: number, diff: string) => ({ index: i, diff, tokens: 0, passed: true, extraPassed: 0, verifyOutput: "exit=0", summary: `s${i}` });
  assert.equal(await modelJudge(model, "add sum()")([c(0, "+++ b/a.ts\n+x"), c(1, "+++ b/b.ts\n+y")]), 1);
  assert.match(prompt, /Task:\nadd sum\(\)[\s\S]*Candidate 1[\s\S]*Changed: a\.ts[\s\S]*Candidate 2[\s\S]*Changed: b\.ts/);
  assert.equal(await modelJudge(async () => ({ role: "assistant", content: "no idea" }), "t")([c(0, ""), c(1, "")]), 0);
});

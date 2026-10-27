// Public-benchmark style suites (SWE-bench format) as eval cases: clone a repository, check out the base commit, let the agent work, then apply the hidden tests and run them.
// Each instance prepares itself in setup(); one that cannot be prepared is EXCLUDED and listed in the report's ledger instead of silently counting as a failure.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell } from "./code.ts";
import type { Case } from "./evals.ts";

export type SuiteInstance = { id: string; repo: string; baseCommit: string; problem: string; testPatch?: string; goldPatch?: string; failToPass: string[]; passToPass: string[]; installCmd?: string };
const sh = (cwd: string, file: string, args: string[], timeout = 300_000): Promise<string> => new Promise((res, rej) => execFile(file, args, { cwd, timeout, maxBuffer: 64 << 20 }, (e, out, err) => (e ? rej(new Error(`${file} ${args.slice(0, 3).join(" ")}: ${(err || e.message).trim().split("\n")[0]}`)) : res(out))));
const list = (v: unknown): string[] => { if (Array.isArray(v)) return v.map(String); if (typeof v === "string") { try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map(String); } catch { /* a plain string */ } return v ? [v] : []; } return []; };

/** Read a JSONL file in SWE-bench's field names (instance_id, repo, base_commit, problem_statement, test_patch, patch, FAIL_TO_PASS, PASS_TO_PASS) or in short names (id, ...). */
export function loadSuite(file: string): SuiteInstance[] {
  const out: SuiteInstance[] = [];
  for (const [i, l] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!l.trim()) continue; let j: Record<string, unknown>; try { j = JSON.parse(l); } catch { throw new Error(`${file}:${i + 1} is not valid JSON`); }
    const id = String(j.instance_id ?? j.id ?? ""), repo = String(j.repo ?? ""), base = String(j.base_commit ?? j.baseCommit ?? ""), problem = String(j.problem_statement ?? j.problem ?? "");
    if (!id || !repo || !base || !problem) throw new Error(`${file}:${i + 1}: each instance needs instance_id, repo, base_commit and problem_statement`);
    out.push({ id, repo: /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.startsWith(".") ? `https://github.com/${repo}.git` : repo, baseCommit: base, problem, testPatch: (j.test_patch ?? j.testPatch) as string | undefined, goldPatch: (j.patch ?? j.gold_patch) as string | undefined, failToPass: list(j.FAIL_TO_PASS ?? j.fail_to_pass), passToPass: list(j.PASS_TO_PASS ?? j.pass_to_pass), installCmd: (j.install_cmd as string | undefined) });
  }
  return out;
}

/** Turn instances into cases. `testCmd` is a template: `{tests}` becomes the instance's FAIL_TO_PASS (and PASS_TO_PASS when `regression`) test ids joined by spaces. */
export function suiteToCases(instances: SuiteInstance[], o: { testCmd: string; installCmd?: string; regression?: boolean; limit?: number }): Case[] {
  return instances.slice(0, o.limit ?? instances.length).map((inst) => {
    const tests = [...inst.failToPass, ...(o.regression ? inst.passToPass : [])].join(" "), cmd = o.testCmd.replace("{tests}", tests);
    return {
      name: inst.id, files: {}, task: `${inst.problem.trim()}\n\nFix the problem in this repository. Do not modify existing tests.`,
      setup: async (dir: string) => {
        await sh(dir, "git", ["clone", "--quiet", inst.repo, "."]); await sh(dir, "git", ["checkout", "--quiet", inst.baseCommit]);
        const install = inst.installCmd ?? o.installCmd; if (install) { const r = await runShell(install, dir, 600_000); if (!r.startsWith("exit=0")) throw new Error(`install failed: ${r.split("\n")[1] ?? r.slice(0, 100)}`); }
      },
      // The hidden tests are applied only now, after the agent is done, from a file outside the workspace.
      check: async (dir: string) => {
        if (inst.testPatch) { const tmp = mkdtempSync(join(tmpdir(), "amness-tp-")), f = join(tmp, "test.patch"); writeFileSync(f, inst.testPatch.endsWith("\n") ? inst.testPatch : inst.testPatch + "\n");
          try { await sh(dir, "git", ["apply", "--whitespace=nowarn", f]); } catch (e) { return `could not apply the hidden tests (${(e as Error).message})`; } finally { rmSync(tmp, { recursive: true, force: true }); } }
        return (await runShell(cmd, dir, 900_000)).startsWith("exit=0") || "the hidden tests still fail";
      },
    } satisfies Case;
  });
}

export type Leak = { id: string; problem: string };
/**
 * Contamination checks that need no model. For every instance: (1) lines the gold patch ADDS must not appear in the problem statement, (2) they must not already exist in the
 * base checkout (a fix that is already there makes the task trivial or broken), (3) the base commit must exist.
 */
export async function leakAudit(instances: SuiteInstance[]): Promise<Leak[]> {
  const out: Leak[] = [];
  for (const inst of instances) {
    const dir = mkdtempSync(join(tmpdir(), "amness-audit-"));
    try {
      try { await sh(dir, "git", ["clone", "--quiet", "--no-checkout", inst.repo, "."]); await sh(dir, "git", ["checkout", "--quiet", inst.baseCommit]); } catch (e) { out.push({ id: inst.id, problem: `cannot check out the base commit: ${(e as Error).message}` }); continue; }
      const added = [...new Set((inst.goldPatch ?? "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter((l) => l.length >= 25))];
      const inProblem = added.filter((l) => inst.problem.includes(l));
      if (inProblem.length) out.push({ id: inst.id, problem: `the problem statement contains ${inProblem.length} line(s) of the fix, e.g. "${inProblem[0].slice(0, 60)}"` });
      let present = 0; for (const l of added.slice(0, 40)) { try { if ((await sh(dir, "git", ["grep", "-F", "-q", "--", l]).then(() => true, () => false))) present++; } catch { /* ignore */ } }
      if (added.length >= 3 && present / Math.min(added.length, 40) > 0.6) out.push({ id: inst.id, problem: `${present} of the ${Math.min(added.length, 40)} lines the fix adds already exist in the base checkout (the fix may already be applied)` });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

// `amness eval`: compare harness variants on a task suite, with statistics you can act on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tune, writeProfile, adversarialCases, hardCases, analyze, builtinCases, evaluate, recommend, leakAudit, loadSuite, suiteToCases, formatReport, harnessVariant, loadCases, selfTest, variantNames, VARIANT_HELP, type Case, type Model, type Row } from "../src/index.ts";
import { bold, dim, green, red } from "./ui.ts";

export const EVAL_HELP = `usage: amness eval [flags]
  Run the coding agent on a suite of tasks under several harness variants and compare them statistically.

  --variants <spec>    preset or comma list (default: ab).  presets: ab · ablate · all
                       variants: ${VARIANT_HELP}
  --trials <n>         attempts per task and variant (default 3)
  --suite <file.jsonl> a benchmark in SWE-bench format (instance_id, repo, base_commit, problem_statement, test_patch, FAIL_TO_PASS...); needs --test-cmd
  --test-cmd <cmd>     how to run the hidden tests; \`{tests}\` is replaced by the instance's FAIL_TO_PASS ids, e.g. "python -m pytest -x -q {tests}"
  --install <cmd>      run once per instance after checkout (dependencies)
  --limit <n>          only the first n instances of a suite
  --audit              contamination checks on a suite (fix lines in the problem statement or already in the base checkout); runs no model
  --seed <n>           seed for the bootstrap intervals (reproducible reports)
  --builtin <name>     which built-in suite: code (default, 13 easy tasks), hard (6 tasks with hidden edge cases, a misleading symptom and an exploration question) or adversarial (prompt-injection attempts; a run passes only if the injected command never ran)
  --cases <dir>        your own tasks: a folder of *.json ({ name, files, task, verify, check })
  --only <a,b>         run only these built-in tasks
  --baseline <name>    variant the others are compared with (default: the first)
  --cheap-model <id>   the cheaper model for the full+route variant (same provider)
  --jobs <n>           sessions run at once (default 1)
  --max-tokens <n>     token cap per session (default: your configured budget)
  --max-steps <n>      steps per session (default 30)
  --profile-out <f>    after an ablation, write the recommended profile (guards the data says to switch off) for --profile-model
  --profile-model <p>  the model name or pattern the profile applies to (default: the configured model)
  --out <file>         where to save raw results (default .amness/evals/<time>.json)
  --report <file>      re-analyse saved results; runs nothing
  --selftest           check that every task is solvable and its held-out check is sound; runs no model
  --yes                skip the cost confirmation`;

export async function runEval(argv: string[], deps: { model: () => Model; modelFor?: (id: string) => Model; maxTokens: number; confirm: (q: string) => Promise<boolean> }): Promise<number> {
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; }, has = (f: string) => argv.includes(f);
  if (has("--help") || has("-h")) { console.log(EVAL_HELP); return 0; }
  try {
    if (has("--report")) {
      const saved = JSON.parse(readFileSync(resolve(val("--report")!), "utf8")) as { rows: Row[]; baseline?: string; k?: number };
      console.log(formatReport(analyze(saved.rows, { baseline: val("--baseline") ?? saved.baseline, k: saved.k }))); return 0;
    }
    const builtin = val("--builtin") ?? "code"; if (!["code", "adversarial", "hard"].includes(builtin)) throw new Error(`unknown built-in suite "${builtin}" (code, hard or adversarial)`);
    let cases: Case[] = val("--cases") ? loadCases(resolve(val("--cases")!)) : builtin === "adversarial" ? adversarialCases : builtin === "hard" ? hardCases : builtinCases;
    if (val("--suite")) {
      const inst = loadSuite(resolve(val("--suite")!)).slice(0, Number(val("--limit") ?? 1e9));
      if (has("--audit")) { const leaks = await leakAudit(inst); for (const l of leaks) console.log(`${red("leak")} ${l.id}: ${l.problem}`); console.log(leaks.length ? `${leaks.length} instance(s) with problems` : green("no contamination found in " + inst.length + " instance(s)")); return leaks.length ? 1 : 0; }
      if (!val("--test-cmd")) throw new Error('a suite needs --test-cmd, e.g. --test-cmd "python -m pytest -x -q {tests}"');
      cases = suiteToCases(inst, { testCmd: val("--test-cmd")!, installCmd: val("--install") });
    }
    if (val("--only")) { const want = val("--only")!.split(","); cases = cases.filter((c) => want.includes(c.name)); if (!cases.length) throw new Error(`no task matches --only ${val("--only")}`); }
    if (has("--selftest")) {
      const res = await selfTest(cases);
      for (const r of res) console.log(`${r.ok ? green("ok ") : red("bad")} ${r.case}${r.why ? dim("  " + r.why) : ""}`);
      return res.every((r) => r.ok) ? 0 : 1;
    }
    const names = variantNames(val("--variants") ?? "ab"), trials = Math.max(1, Number(val("--trials") ?? 3)), jobs = Math.max(1, Number(val("--jobs") ?? 1));
    const maxTokens = Number(val("--max-tokens") ?? deps.maxTokens), maxSteps = Number(val("--max-steps") ?? 30);
    const model = deps.model(), cheap = val("--cheap-model") && deps.modelFor ? deps.modelFor(val("--cheap-model")!) : undefined, variants = names.map((n) => harnessVariant(model, n, { maxTokens, maxSteps, cheap }));
    const runs = cases.length * variants.length * trials;
    console.log(`${bold("plan")}  ${cases.length} tasks × ${variants.length} variants (${names.join(", ")}) × ${trials} trials = ${bold(String(runs))} agent sessions, up to ${maxTokens.toLocaleString()} tokens each`);
    if (!has("--yes") && !(await deps.confirm(`This calls your model up to ${(runs * maxTokens).toLocaleString()} tokens in the worst case. Continue?`))) return 1;
    const { rows, analysis } = await evaluate(cases, variants, {
      trials, jobs, baseline: val("--baseline"), k: Math.min(3, trials), seed: val("--seed") ? Number(val("--seed")) : undefined,
      onRow: (r) => console.error(`  ${r.pass ? green("PASS") : red("FAIL")} ${r.case.padEnd(22)} ${r.variant.padEnd(18)} ${dim(`${r.steps} steps · ${r.tokens} tok · ${(r.ms / 1000).toFixed(1)}s${r.note ? " · " + r.note : ""}`)}`),
    });
    const out = resolve(val("--out") ?? join(".amness", "evals", new Date().toISOString().replace(/[:.]/g, "-") + ".json"));
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), baseline: analysis.baseline, k: Math.min(3, trials), variants: names, trials, rows }, null, 1));
    if (val("--profile-out")) {
      const rec = recommend(analysis, names.includes("full") ? "full" : analysis.baseline), pm = val("--profile-model") ?? "*";
      console.log("\nguard verdicts:"); for (const v of rec.verdicts) console.log(`  ${v.action === "remove" ? "remove" : v.action === "keep" ? "KEEP  " : "keep? "} ${v.guard.padEnd(11)} ${v.why}`); console.log(`  ${rec.strength}`);
      writeFileSync(resolve(val("--profile-out")!), JSON.stringify({ models: { [pm]: rec.profile } }, null, 2) + "\n"); console.log(`profile written to ${val("--profile-out")}: copy it to .amness/profile.json`);
    }
    console.log("\n" + formatReport(analysis) + "\n\n" + dim(`raw results: ${out}  (re-analyse with: amness eval --report ${out})`));
    return 0;
  } catch (e) { console.error(red("✗ " + (e as Error).message)); return 2; }
}

export const TUNE_HELP = `usage: amness tune [flags]
  Try switching guards off (and changing a limit), one at a time, on part of your tasks; keep a change only if it also holds up on tasks the search never saw. Rolled back otherwise.
  Writes nothing unless something survives both checks. Calls your model: it asks first.

  --cases <dir>        your own tasks (default: the 13 built-in tasks)
  --guards <a,b>       which guards to try removing (default: nudge, loop, stuck, wrapup, condense, stagnation)
  --stagnation <n,n>   also try these stagnationTurns values
  --trials <n>         attempts per task (default 2)
  --max-steps <n>      steps per session (default 30)
  --max-tokens <n>     token cap per session
  --jobs <n>           sessions at once (default 1)
  --seed <n>           seed for the split and the intervals
  --profile-model <p>  the model name or pattern to write the profile for (default: the configured model)
  --out <file>         where to write the profile (default .amness/profile.json)
  --yes                skip the cost confirmation`;

export async function runTune(argv: string[], deps: { model: () => Model; modelName: string; maxTokens: number; confirm: (q: string) => Promise<boolean> }): Promise<number> {
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--help") || argv.includes("-h")) { console.log(TUNE_HELP); return 0; }
  try {
    const cases = val("--cases") ? loadCases(resolve(val("--cases")!)) : builtinCases, model = deps.model(), maxTokens = Number(val("--max-tokens") ?? deps.maxTokens), maxSteps = Number(val("--max-steps") ?? 30);
    const guards = val("--guards")?.split(",").map((s) => s.trim()) as any, stag = val("--stagnation")?.split(",").map(Number), trials = Math.max(1, Number(val("--trials") ?? 2));
    const n = (guards?.length ?? 6) + (stag?.length ?? 0), runs = Math.round(cases.length * 0.66) * 2 * trials * n + Math.max(1, Math.round(cases.length * 0.34)) * 2 * trials;
    console.log(`${bold("plan")}  up to ${runs} agent sessions (${cases.length} tasks, ${n} candidate changes, ${trials} trial(s)), up to ${maxTokens.toLocaleString()} tokens each`);
    if (!argv.includes("--yes") && !(await deps.confirm(`This calls your model up to ${(runs * maxTokens).toLocaleString()} tokens in the worst case. Continue?`))) return 1;
    const r = await tune({ cases, trials, guards, stagnationTurns: stag, jobs: Number(val("--jobs") ?? 1), seed: val("--seed") ? Number(val("--seed")) : undefined,
      makeVariant: (profile, name) => ({ ...harnessVariant(model, "full", { maxTokens, maxSteps, profile }), name }),
      onStep: (s) => console.log(`  ${s.accepted ? green("keep") : red("drop")} ${s.stage === "heldout" ? "[held-out] " : ""}${s.change}  ${dim(s.why)}`) });
    console.log(dim(`\n${r.strength}; held-out tasks: ${r.heldOut.join(", ") || "none"}`));
    if (!r.accepted.length) { console.log("nothing survived both checks; no profile written."); return 0; }
    const out = resolve(val("--out") ?? join(".amness", "profile.json")); writeProfile(out, val("--profile-model") ?? deps.modelName, r.profile);
    console.log(`kept: ${r.accepted.join(", ")}\nprofile written to ${out}`); return 0;
  } catch (e) { console.error(red("✗ " + (e as Error).message)); return 2; }
}

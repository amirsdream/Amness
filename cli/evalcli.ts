// `amness eval`: compare harness variants on a task suite, with statistics you can act on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyze, builtinCases, evaluate, formatReport, harnessVariant, loadCases, selfTest, variantNames, VARIANT_HELP, type Case, type Model, type Row } from "../src/index.ts";
import { bold, dim, green, red } from "./ui.ts";

export const EVAL_HELP = `usage: amness eval [flags]
  Run the coding agent on a suite of tasks under several harness variants and compare them statistically.

  --variants <spec>    preset or comma list (default: ab).  presets: ab · ablate · all
                       variants: ${VARIANT_HELP}
  --trials <n>         attempts per task and variant (default 3)
  --cases <dir>        your own tasks: a folder of *.json ({ name, files, task, verify, check })
  --only <a,b>         run only these built-in tasks
  --baseline <name>    variant the others are compared with (default: the first)
  --jobs <n>           sessions run at once (default 1)
  --max-tokens <n>     token cap per session (default: your configured budget)
  --max-steps <n>      steps per session (default 30)
  --out <file>         where to save raw results (default .amness/evals/<time>.json)
  --report <file>      re-analyse saved results; runs nothing
  --selftest           check that every task is solvable and its held-out check is sound; runs no model
  --yes                skip the cost confirmation`;

export async function runEval(argv: string[], deps: { model: () => Model; maxTokens: number; confirm: (q: string) => Promise<boolean> }): Promise<number> {
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; }, has = (f: string) => argv.includes(f);
  if (has("--help") || has("-h")) { console.log(EVAL_HELP); return 0; }
  try {
    if (has("--report")) {
      const saved = JSON.parse(readFileSync(resolve(val("--report")!), "utf8")) as { rows: Row[]; baseline?: string; k?: number };
      console.log(formatReport(analyze(saved.rows, { baseline: val("--baseline") ?? saved.baseline, k: saved.k }))); return 0;
    }
    let cases: Case[] = val("--cases") ? loadCases(resolve(val("--cases")!)) : builtinCases;
    if (val("--only")) { const want = val("--only")!.split(","); cases = cases.filter((c) => want.includes(c.name)); if (!cases.length) throw new Error(`no task matches --only ${val("--only")}`); }
    if (has("--selftest")) {
      const res = await selfTest(cases);
      for (const r of res) console.log(`${r.ok ? green("ok ") : red("bad")} ${r.case}${r.why ? dim("  " + r.why) : ""}`);
      return res.every((r) => r.ok) ? 0 : 1;
    }
    const names = variantNames(val("--variants") ?? "ab"), trials = Math.max(1, Number(val("--trials") ?? 3)), jobs = Math.max(1, Number(val("--jobs") ?? 1));
    const maxTokens = Number(val("--max-tokens") ?? deps.maxTokens), maxSteps = Number(val("--max-steps") ?? 30);
    const model = deps.model(), variants = names.map((n) => harnessVariant(model, n, { maxTokens, maxSteps }));
    const runs = cases.length * variants.length * trials;
    console.log(`${bold("plan")}  ${cases.length} tasks × ${variants.length} variants (${names.join(", ")}) × ${trials} trials = ${bold(String(runs))} agent sessions, up to ${maxTokens.toLocaleString()} tokens each`);
    if (!has("--yes") && !(await deps.confirm(`This calls your model up to ${(runs * maxTokens).toLocaleString()} tokens in the worst case. Continue?`))) return 1;
    const { rows, analysis } = await evaluate(cases, variants, {
      trials, jobs, baseline: val("--baseline"), k: Math.min(3, trials),
      onRow: (r) => console.error(`  ${r.pass ? green("PASS") : red("FAIL")} ${r.case.padEnd(22)} ${r.variant.padEnd(18)} ${dim(`${r.steps} steps · ${r.tokens} tok · ${(r.ms / 1000).toFixed(1)}s${r.note ? " · " + r.note : ""}`)}`),
    });
    const out = resolve(val("--out") ?? join(".amness", "evals", new Date().toISOString().replace(/[:.]/g, "-") + ".json"));
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), baseline: analysis.baseline, k: Math.min(3, trials), variants: names, trials, rows }, null, 1));
    console.log("\n" + formatReport(analysis) + "\n\n" + dim(`raw results: ${out}  (re-analyse with: amness eval --report ${out})`));
    return 0;
  } catch (e) { console.error(red("✗ " + (e as Error).message)); return 2; }
}

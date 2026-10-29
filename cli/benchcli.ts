// `amness bench`: a bake-off between coding-agent CLIs on the same tasks, graded by the same hidden checks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PRESETS, adversarialCases, analyze, bench, builtinCases, configFileTemplate, describePlan, formatReport, hardCases, installed, loadCases, loadSuite, suiteToCases, type BenchConfig, type Case, type Contestant } from "../src/index.ts";
import { bold, dim, green, red, yellow } from "./ui.ts";

export const BENCH_HELP = `usage: amness bench [flags]
  Run the same tasks through several coding-agent command-line tools (Amness, Claude Code, Codex, or any command) and grade every result with the same hidden check.

  --init [file]          write a starter config (default bench.json) with Amness, Amness with a finish gate, Claude Code and Codex, then edit it
  --config <file>        the contestants and settings (see --init). Without it, --contestants picks built-in presets
  --contestants <a,b>    presets: ${Object.keys(PRESETS).join(", ")}   (default: amness,claude,codex)
  --model <name>         one model name for every contestant that takes one; or --models amness=gpt-6-luna,claude=claude-sonnet-5-5,codex=gpt-6-luna
  --builtin <name>       code (default, 13 easy tasks), hard (6 harder tasks) or adversarial
  --cases <dir|file>     your own tasks: a folder of *.json, or a .ts/.js module exporting a list of cases
  --suite <file.jsonl>   a SWE-bench-format file; needs --test-cmd (see amness eval --help)   --limit <n>   --install <cmd>
  --only <a,b>           only these tasks
  --trials <n>           attempts per task and contestant (default 3)   --jobs <n>   runs at once (default 1; the tools use your API limits)
  --timeout <seconds>    per run (default 900)
  --check                see which of the tools are installed (no model call)
  --probe                one tiny real task per contestant, to confirm the tool starts, is graded, and its tokens and cost are read correctly (costs a few cents)
  --dry-run              show exactly what would run, change nothing
  --out <file>           where to save the raw results (re-read with: amness eval --report <file>)
  --yes                  skip the cost confirmation
Safety: each run happens in a throw-away temp folder, but the tools run with their file and shell tools enabled and are NOT sandboxed from the rest of your machine. Run benchmarks in a VM or container if the tasks are not yours.`;

async function pickCases(val: (f: string) => string | undefined, has: (f: string) => boolean): Promise<Case[]> {
  let cases: Case[];
  const arg = val("--cases"), suite = val("--suite");
  if (suite) { if (!val("--test-cmd")) throw new Error('a suite needs --test-cmd, for example --test-cmd "python -m pytest -x -q {tests}"'); cases = suiteToCases(loadSuite(resolve(suite)).slice(0, Number(val("--limit") ?? 1e9)), { testCmd: val("--test-cmd")!, installCmd: val("--install") }); }
  else if (arg && /\.(m?[jt]s)$/.test(arg)) { const mod = await import(pathToFileURL(resolve(arg)).href + `?v=${Date.now()}`); cases = mod.default ?? mod.cases; if (!Array.isArray(cases)) throw new Error(`${arg} must export a list of cases`); }
  else if (arg) cases = loadCases(resolve(arg));
  else { const b = val("--builtin") ?? "code"; if (!["code", "hard", "adversarial"].includes(b)) throw new Error(`unknown built-in suite "${b}"`); cases = b === "hard" ? hardCases : b === "adversarial" ? adversarialCases : builtinCases; }
  if (val("--only")) { const want = val("--only")!.split(","); cases = cases.filter((c) => want.includes(c.name)); if (!cases.length) throw new Error(`no task matches --only ${val("--only")}`); }
  void has; return cases;
}

export async function runBench(argv: string[], deps: { confirm: (q: string) => Promise<boolean>; amnessCli: string }): Promise<number> {
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; }, has = (f: string) => argv.includes(f);
  if (has("--help") || has("-h")) { console.log(BENCH_HELP); return 0; }
  try {
    if (has("--init")) {
      const i = argv.indexOf("--init"), file = resolve(argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "bench.json");
      if (existsSync(file)) { console.error(red("✗ ") + `${file} already exists`); return 1; }
      writeFileSync(file, JSON.stringify(configFileTemplate(deps.amnessCli), null, 2) + "\n");
      console.log(green("wrote ") + file + "\n" + dim("Edit it: set a model for each contestant, remove the ones you do not have, change trials/jobs/timeout. Then: amness bench --config " + file + " --dry-run")); return 0;
    }
    let cfg: BenchConfig;
    if (val("--config")) cfg = JSON.parse(readFileSync(resolve(val("--config")!), "utf8")) as BenchConfig;
    else {
      const models: Record<string, string> = Object.fromEntries((val("--models") ?? "").split(",").filter(Boolean).map((p) => p.split("=") as [string, string]));
      const names = (val("--contestants") ?? "amness,claude,codex").split(",").map((s) => s.trim()).filter(Boolean);
      cfg = { contestants: names.map((n) => { if (!PRESETS[n]) throw new Error(`unknown preset "${n}". Presets: ${Object.keys(PRESETS).join(", ")}. For anything else use --config.`); return PRESETS[n]({ model: models[n] ?? val("--model"), amnessCli: deps.amnessCli }); }) };
    }
    if (!cfg.contestants?.length) throw new Error("no contestants");
    for (const k of cfg.contestants) { if (!k.name || !k.command) throw new Error("every contestant needs a name and a command"); if (k.args === undefined) k.args = []; }
    if (new Set(cfg.contestants.map((k) => k.name)).size !== cfg.contestants.length) throw new Error("contestant names must be different");
    if (val("--trials")) cfg.trials = Number(val("--trials")); if (val("--jobs")) cfg.jobs = Number(val("--jobs")); if (val("--timeout")) cfg.timeoutSec = Number(val("--timeout"));
    cfg.trials ??= 3; cfg.jobs ??= 1; cfg.logDir ??= join(".amness", "bench", "logs");

    if (has("--check")) {
      let bad = 0; for (const k of cfg.contestants) { const ok = installed(k.command); if (!ok) bad++; console.log(`${ok ? green("found   ") : red("missing ")} ${k.name.padEnd(14)} ${k.command}${ok ? "" : dim("  (not on PATH)")}`); }
      return bad ? 1 : 0;
    }
    const cases = has("--probe") ? [{ name: "probe", files: {}, task: "Create a file named hello.txt that contains exactly: hi", verify: "node -e \"process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hi'?0:1)\"", check: async (d: string) => { try { return readFileSync(join(d, "hello.txt"), "utf8").trim() === "hi" || "hello.txt is wrong"; } catch { return "no hello.txt"; } } } as Case] : await pickCases(val, has);
    if (has("--probe")) { cfg.trials = 1; cfg.jobs = 1; cfg.timeoutSec = Math.min(cfg.timeoutSec ?? 300, 300); }
    for (const l of describePlan(cases, cfg)) console.log(l);
    const missing = cfg.contestants.filter((k) => !installed(k.command)); for (const k of missing) console.log(yellow("! ") + `${k.name}: "${k.command}" is not on PATH`);
    if (has("--dry-run")) return 0;
    if (missing.length === cfg.contestants.length) { console.error(red("✗ ") + "none of the contestants can start"); return 1; }
    const runs = cases.length * cfg.contestants.length * cfg.trials;
    if (!has("--yes") && !(await deps.confirm(`This starts up to ${runs} agent run(s) that spend real money on your accounts (the tools bill you themselves). Continue?`))) return 1;
    mkdirSync(join(".amness", "bench"), { recursive: true });
    const { rows, analysis } = await bench(cases, cfg, { onRow: (r) => console.error(`  ${r.pass ? green("PASS") : red("FAIL")} ${r.case.padEnd(24)} ${r.variant.padEnd(14)} ${dim(`${(r.ms / 1000).toFixed(0)}s${r.tokens ? ` · ${r.tokens} tok` : ""}${r.metrics?.["cost-usd"] !== undefined ? ` · $${r.metrics["cost-usd"].toFixed(3)}` : ""}${r.note ? " · " + r.note : ""}`)}`) });
    const out = resolve(val("--out") ?? join(".amness", "bench", new Date().toISOString().replace(/[:.]/g, "-") + ".json"));
    mkdirSync(join(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), baseline: analysis.baseline, k: Math.min(3, cfg.trials), contestants: cfg.contestants, trials: cfg.trials, rows }, null, 1));
    console.log("\n" + formatReport(analyze(rows, { k: Math.min(3, cfg.trials) })));
    console.log("\n" + bold("what each contestant was") + "\n" + cfg.contestants.map((k) => `  ${k.name}: ${k.model ? "model " + k.model : "default model"}${k.note ? "; " + k.note : ""}`).join("\n"));
    console.log("\n" + dim(`raw results: ${out}  (amness eval --report ${out}). Raw output of every run: ${cfg.logDir}`));
    console.log(dim("Read this fairly: the tools differ in prompts, default models and permissions, and tokens or cost are shown only when the tool reports them."));
    return 0;
  } catch (e) { console.error(red("✗ ") + (e as Error).message); return 2; }
}

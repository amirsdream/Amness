// Bake-off: run the same tasks through different coding-agent CLIs (Amness, Claude Code, Codex, anything with a command line) and grade every result with the same hidden check.
// What it can say honestly: pass rate with a confidence range, cost, tokens and time per solved task. What it cannot do: make the contestants equal. Prompts, tools, default models and
// permissions differ, so the report names every setting that was used. Each contestant is described as data (a command template), so you can change anything, and add your own.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analyze, type Analysis, type Case, type Row } from "./evals.ts";
import { runShell } from "./code.ts";

export type ParseMode = "claude-json" | "codex-jsonl" | "amness-json" | "none";
export type Contestant = {
  name: string;
  /** the program to run (resolved through PATH; on Windows .cmd and .ps1 shims work too) */ command: string;
  /** arguments; the placeholders {task} {cwd} {model} {verify} are replaced */ args?: string[];
  /** send the prompt on standard input instead of in an argument (recommended: no quoting problems) */ stdin?: boolean;
  model?: string; env?: Record<string, string>; /** how to read tokens and cost from the output */ parse?: ParseMode;
  /** kill the run after this many seconds (default: the bench's timeout) */ timeoutSec?: number;
  /** a note shown in the report, for example "uses my Claude login, loads my CLAUDE.md" */ note?: string;
};
export type BenchConfig = {
  contestants: Contestant[];
  /** the prompt given to every contestant; {task} is the task text, {verify} the check command the task offers (default below) */ promptTemplate?: string;
  /** make a git repository in each task folder first (agents often expect one; default true) */ gitInit?: boolean;
  timeoutSec?: number; trials?: number; jobs?: number; /** where to keep each run's raw output for audit */ logDir?: string;
};
export const DEFAULT_PROMPT = "{task}\n\nWhen you believe you are done, check your work by running: {verify}";

// ------------------------------------------------------------------ presets (verify the flags with your installed version: `claude --help`, `codex exec --help`)
export const PRESETS: Record<string, (o: { model?: string; amnessCli?: string }) => Contestant> = {
  amness: ({ model, amnessCli }) => ({ name: "amness", command: "node", args: [amnessCli ?? resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "cli", "amness.ts"), "run", "--json", "--yes", "--max-tokens", "400000", ...(model ? ["--model", model] : []), "-"], stdin: true, parse: "amness-json", model, note: "headless `amness run`; the default harness without a finish gate" }),
  "amness-gate": ({ model, amnessCli }) => ({ ...PRESETS.amness({ model, amnessCli }), name: "amness-gate", args: [...PRESETS.amness({ model, amnessCli }).args!.slice(0, -1), "--verify", "{verify}", "-"], note: "headless `amness run` with --verify: it may not finish until the check passes (the other contestants only get the check in the prompt)" }),
  claude: ({ model }) => ({ name: "claude", command: "claude", args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write", ...(model ? ["--model", model] : [])], stdin: true, parse: "claude-json", model, note: "Claude Code print mode with YOUR login, settings, CLAUDE.md and hooks (use claude-bare for a clean room)" }),
  "claude-bare": ({ model }) => ({ name: "claude-bare", command: "claude", args: ["--bare", "-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write", ...(model ? ["--model", model] : [])], stdin: true, parse: "claude-json", model, note: "Claude Code --bare: no user settings, hooks, CLAUDE.md or memory; needs ANTHROPIC_API_KEY (no subscription login)" }),
  codex: ({ model }) => ({ name: "codex", command: "codex", args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write", ...(model ? ["--model", model] : []), "-"], stdin: true, parse: "codex-jsonl", model, note: "codex exec in a workspace-write sandbox, ignoring your user config and rules" }),
};

// ------------------------------------------------------------------ output parsers
export type ParsedUsage = { input?: number; output?: number; cached?: number; costUsd?: number; turns?: number; text?: string; isError?: boolean };
const jsonLines = (s: string): any[] => s.split(/\r?\n/).flatMap((l) => { const t = l.trim(); if (!t.startsWith("{") && !t.startsWith("[")) return []; try { return [JSON.parse(t)]; } catch { return []; } });
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
export function parseOutput(mode: ParseMode | undefined, stdout: string): ParsedUsage {
  if (!mode || mode === "none") return {};
  if (mode === "claude-json") {
    // one JSON object (print mode), or a stream whose last line is the result message
    let objs = jsonLines(stdout); if (!objs.length) { try { objs = [JSON.parse(stdout)]; } catch { return {}; } }
    const r = [...objs.flat()].reverse().find((o) => o && (o.type === "result" || "total_cost_usd" in o)) ?? objs.at(-1) ?? {}, u = r.usage ?? {};
    const cached = (num(u.cache_read_input_tokens) ?? 0), fresh = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
    return { input: fresh + cached, cached, output: num(u.output_tokens), costUsd: num(r.total_cost_usd), turns: num(r.num_turns), text: typeof r.result === "string" ? r.result : undefined, isError: !!r.is_error };
  }
  if (mode === "amness-json") {
    const r = [...jsonLines(stdout)].reverse().find((o) => o.kind === "result");
    return r ? { input: num(r.tokens), output: undefined, turns: num(r.steps), text: typeof r.text === "string" ? r.text : undefined, isError: r.finished === false } : {};
  }
  // codex-jsonl: the token event is not documented, so this reads what is commonly there: a cumulative `total_token_usage` (last one wins), else the sum of per-turn `usage` objects.
  let total: any, sum = { i: 0, o: 0, c: 0 }, any = false, text: string | undefined;
  const walk = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (x.total_token_usage && typeof x.total_token_usage === "object") total = x.total_token_usage;
    else if (x.usage && typeof x.usage === "object" && (num(x.usage.input_tokens) !== undefined || num(x.usage.output_tokens) !== undefined)) { any = true; sum.i += num(x.usage.input_tokens) ?? 0; sum.o += num(x.usage.output_tokens) ?? 0; sum.c += num(x.usage.cached_input_tokens) ?? 0; }
    if ((x.type === "agent_message" || x.item?.type === "agent_message") && typeof (x.text ?? x.item?.text) === "string") text = x.text ?? x.item.text;
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  for (const o of jsonLines(stdout)) walk(o);
  if (total) return { input: num(total.input_tokens), output: num(total.output_tokens), cached: num(total.cached_input_tokens), text };
  return any ? { input: sum.i, output: sum.o, cached: sum.c, text } : { text };
}

// ------------------------------------------------------------------ running one contestant
/** Quote an argument for cmd.exe / a POSIX shell when a shell is needed (Windows .cmd shims). */
export const shellQuote = (a: string, win = process.platform === "win32") => (win ? (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`) : a);
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(task|cwd|model|verify)\}/g, (_, k) => v[k] ?? "");
export function commandLine(c: Contestant, vars: Record<string, string>): { file: string; args: string[] } { return { file: c.command, args: (c.args ?? []).map((a) => fill(a, vars)) }; }
function killTree(p: ChildProcess) {
  if (!p.pid) return;
  try { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } }
}
export type ContestantRun = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; startError?: string };
export function runContestant(c: Contestant, vars: Record<string, string>, prompt: string, cwd: string, timeoutSec: number): Promise<ContestantRun> {
  const { file, args } = commandLine(c, vars), win = process.platform === "win32", t0 = Date.now();
  return new Promise((res) => {
    let out = "", err = "", timedOut = false, done = false;
    const p = spawn(file, win ? args.map((a) => shellQuote(a, true)) : args, { cwd, env: { ...process.env, ...c.env }, shell: win, detached: !win, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const finish = (r: Partial<ContestantRun>) => { if (done) return; done = true; clearTimeout(timer); res({ code: null, stdout: out, stderr: err, ms: Date.now() - t0, timedOut, ...r }); };
    const timer = setTimeout(() => { timedOut = true; killTree(p); setTimeout(() => finish({ code: null }), 2000).unref(); }, timeoutSec * 1000);
    p.stdout!.on("data", (d) => { if (out.length < 20_000_000) out += d; }); p.stderr!.on("data", (d) => { if (err.length < 2_000_000) err += d; });
    p.on("error", (e) => finish({ startError: e.message }));
    p.on("close", (code) => finish({ code }));
    p.stdin!.on("error", () => { /* the program may exit before reading the prompt */ });
    if (c.stdin) p.stdin!.end(prompt); else p.stdin!.end();
  });
}

// ------------------------------------------------------------------ the bench
export type BenchProgress = (r: Row & { stderrTail?: string }) => void;
export async function bench(cases: Case[], cfg: BenchConfig, o: { onRow?: BenchProgress; baseline?: string; seed?: number } = {}): Promise<{ rows: Row[]; analysis: Analysis }> {
  const rows: Row[] = [], trials = cfg.trials ?? 1, template = cfg.promptTemplate ?? DEFAULT_PROMPT, logRoot = cfg.logDir ? resolve(cfg.logDir) : undefined;
  const work: (() => Promise<void>)[] = [];
  for (const c of cases) for (const k of cfg.contestants) for (let trial = 0; trial < trials; trial++) work.push(async () => {
    const dir = mkdtempSync(join(tmpdir(), "amness-bench-")), t0 = Date.now(), row: Row = { case: c.name, variant: k.name, trial, pass: false, steps: 0, tokens: 0, ms: 0 };
    try {
      for (const [f, content] of Object.entries(c.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), content); }
      if (c.setup) { try { await c.setup(dir); } catch (e) { row.excluded = (e as Error).message.slice(0, 300); rows.push(row); o.onRow?.(row); return; } }
      if (cfg.gitInit !== false) { const g = (...a: string[]) => spawnSync("git", a, { cwd: dir, stdio: "ignore" }); g("init", "-q"); g("add", "-A"); g("-c", "user.email=bench@example.com", "-c", "user.name=bench", "commit", "-qm", "start", "--allow-empty"); }
      const verify = c.verify ?? "(no check command was given for this task)", vars = { task: c.task, cwd: dir, model: k.model ?? "", verify }, prompt = fill(template, vars);
      const r = await runContestant(k, vars, prompt, dir, k.timeoutSec ?? cfg.timeoutSec ?? 900), u = parseOutput(k.parse, r.stdout);
      row.ms = r.ms; row.steps = u.turns ?? 0; row.tokens = (u.input ?? 0) + (u.output ?? 0); row.prompt = u.input; row.cached = u.cached;
      const j = typeof c.check === "string" ? ((await runShell(c.check, dir, 120_000)).startsWith("exit=0") || "check command failed") : await c.check(dir);
      row.pass = j === true; row.metrics = { ...(u.costUsd !== undefined && { "cost-usd": u.costUsd }), secs: r.ms / 1000 };
      row.note = r.startError ? `could not start ${k.command}: ${r.startError}` : r.timedOut ? `timed out after ${k.timeoutSec ?? cfg.timeoutSec ?? 900}s` : j !== true ? String(j || "failed") : u.isError ? "the tool reported an error but the check passed" : undefined;
      if (logRoot) { const f = join(logRoot, k.name, `${c.name}-${trial}`); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f + ".out.txt", r.stdout); writeFileSync(f + ".err.txt", r.stderr); writeFileSync(f + ".cmd.json", JSON.stringify({ command: k.command, args: commandLine(k, vars).args, exit: r.code, ms: r.ms, usage: u, check: j }, null, 1)); }
      void t0;
    } catch (e) { row.note = "crashed: " + (e as Error).message; }
    rows.push(row); o.onRow?.(row);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ }
  });
  let next = 0; await Promise.all(Array.from({ length: Math.max(1, Math.min(cfg.jobs ?? 1, work.length)) }, async () => { while (next < work.length) await work[next++](); }));
  rows.sort((a, b) => cases.findIndex((x) => x.name === a.case) - cases.findIndex((x) => x.name === b.case) || cfg.contestants.findIndex((x) => x.name === a.variant) - cfg.contestants.findIndex((x) => x.name === b.variant) || a.trial - b.trial);
  return { rows, analysis: analyze(rows, { baseline: o.baseline, k: Math.min(3, trials), seed: o.seed }) };
}

/** What each contestant would run, with the prompt, without running anything. */
export function describePlan(cases: Case[], cfg: BenchConfig): string[] {
  const out: string[] = [], c = cases[0]; if (!c) return ["no tasks"];
  const verify = c.verify ?? "(no check command)", template = cfg.promptTemplate ?? DEFAULT_PROMPT;
  out.push(`${cases.length} task(s) × ${cfg.contestants.length} contestant(s) × ${cfg.trials ?? 1} trial(s) = ${cases.length * cfg.contestants.length * (cfg.trials ?? 1)} runs, up to ${cfg.timeoutSec ?? 900}s each, ${cfg.jobs ?? 1} at a time`);
  out.push("", "prompt for the first task:", ...fill(template, { task: c.task, verify, cwd: "<dir>", model: "" }).split("\n").map((l) => "  " + l), "");
  for (const k of cfg.contestants) { const { file, args } = commandLine(k, { task: c.task, cwd: "<dir>", model: k.model ?? "", verify }); out.push(`${k.name}: ${[file, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${k.stdin ? "   (prompt on stdin)" : ""}${k.model ? `   model: ${k.model}` : "   model: the tool's default"}`, ...(k.note ? [`    ${k.note}`] : [])); }
  return out;
}
export const installed = (command: string): boolean => { const r = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }); return r.status === 0; };
export const configFileTemplate = (amnessCli?: string): BenchConfig => ({
  contestants: [PRESETS.amness({ amnessCli }), PRESETS["amness-gate"]({ amnessCli }), PRESETS.claude({}), PRESETS.codex({})],
  promptTemplate: DEFAULT_PROMPT, gitInit: true, timeoutSec: 900, trials: 3, jobs: 2, logDir: ".amness/bench/logs",
});
void existsSync;

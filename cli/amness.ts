#!/usr/bin/env node
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSessionWorktree, isRepo, removeWorktree, worktreeIsUntouched, caseFromWorkspace, formatMining, formatReplay, replayFile, Budget, MemoryStore, effortsFor, type RunResult, codeVariants, createCodeAgent, createDeepAgent, evaluate, loadMcp, readBundle, startLive, type Approve, type Event, type Model } from "../src/index.ts";
import { createModel } from "./model.ts";
import { detectVerify } from "./detect.ts";
import { HELP, runHeadless } from "./headless.ts";
import { App } from "./tui/app.ts";
import { builtinCases as cases } from "../src/evalcases.ts";
import { runBench } from "./benchcli.ts";
import { runPlugin } from "./plugincli.ts";
import { runSchedule } from "./schedulecli.ts";
import { ACP_HELP, runAcp } from "./acpcli.ts";
import { runEval, runTune } from "./evalcli.ts";
import { CLAUDE_MODELS, OPENAI_MODELS, PROVIDERS, home, loadConfig, mask, ready, saveConfig, type Config, type ProviderId } from "./config.ts";
import { DEMO_TASK, explain, runDemo } from "./demo.ts";
import { formatEvent } from "./format.ts";
import { Cancel, ask, bold, box, clearScreen, confirm, cyan, dim, gray, green, log, pause, red, select, spin, yellow } from "./ui.ts";
import { loadState, rememberTask, saveState } from "./state.ts";

const cfg: Config = loadConfig();
const fail = async (m: string) => { console.log(red("✗ " + m)); await pause(); };
const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";

function banner() {
  const p = PROVIDERS[cfg.provider];
  const key = !p.needsKey ? gray("no key needed") : cfg.apiKey ? green("key set") : red("no API key");
  console.log("\n" + box([
    bold("Amness") + dim("  ·  reliable agents for GPT-style models"),
    `${dim("model")} ${cyan(cfg.model)}  ${dim("via")} ${p.label}  ${dim("·")} ${key}  ${dim("·")} ${dim("budget")} ${cfg.maxTokens.toLocaleString()} tok`,
  ]));
}

/** Live status shown next to the spinner while the model works. */
const status = { t0: Date.now(), step: 0, tokens: 0 };
const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const statusLine = () => `working… ${Math.round((Date.now() - status.t0) / 1000)}s · turn ${status.step + 1} · ${fmtTok(status.tokens)} tokens · ctrl-c stops safely`;
/** Wrap a model so a live spinner shows while it thinks (and the abort signal still reaches the adapter). */
const withSpinner = (m: Model): Model => async (msgs, tools, o) => { const stop = spin(statusLine); try { return await m(msgs, tools, o); } finally { stop(); } };
const rawModel = (retries?: number): Model => createModel(cfg, retries);
// keep appendOnly (Claude) visible through the spinner wrapper
const makeModel = (): Model => { const m = rawModel(), w = withSpinner(m); w.appendOnly = m.appendOnly; return w; };

/** Human-in-the-loop prompt for risky tool calls. */
const approve: Approve = async ({ name, args, reason }) => {
  log(); log(box([yellow(bold("Approval needed")), `${dim("tool  ")} ${name}`, `${dim("why   ")} ${reason ?? "marked risky"}`,
    `${dim("args  ")} ${JSON.stringify(args).slice(0, 300)}`], yellow));
  const a = await select("Allow this?", [
    { label: "Allow once", value: "y" }, { label: "Deny", value: "n" }, { label: "Deny and tell the agent what to do instead", value: "note" },
  ], 1);
  if (a === "y") return true;
  if (a === "note") { try { return (await ask("Instruction for the agent")) || false; } catch (e) { if (e instanceof Cancel) return false; throw e; } }
  return false;
};

const onEvent = (e: Event & { agent?: string }) => { if (e.kind === "turn") { status.step = e.step; status.tokens = e.tokens; } const l = formatEvent(e); if (l) log(l.split("\n").map((x, i) => (i ? x : "  " + x)).join("\n")); };

async function ensureReady(): Promise<boolean> {
  if (ready(cfg)) return true;
  console.log("\n" + box([bold("Let's get you set up"), dim("Pick a provider, paste a key, and we'll test it. Esc cancels; the guided demo works without a key.")], cyan));
  const id = await select("Which provider?", [
    { label: "Anthropic (Claude)", value: "anthropic" as ProviderId, hint: "recommended · key from console.anthropic.com" },
    { label: "OpenAI", value: "openai" as ProviderId, hint: "key from platform.openai.com" },
    { label: "Ollama (local)", value: "ollama" as ProviderId, hint: "no key · tool-calling quality varies by model" },
    { label: "Other OpenAI-compatible", value: "custom" as ProviderId, hint: "vLLM, LM Studio, OpenRouter…" },
  ]);
  if (!id) return false;
  Object.assign(cfg, { provider: id, baseUrl: PROVIDERS[id].baseUrl, model: PROVIDERS[id].model });
  if (id === "custom" || id === "ollama") { cfg.baseUrl = (await ask("Base URL", cfg.baseUrl)) || cfg.baseUrl; cfg.model = (await ask("Model", cfg.model)) || cfg.model; }
  if (PROVIDERS[id].needsKey) cfg.apiKey = (await ask("API key (hidden; saved to ~/.amness/config.json, mode 600)", "", { secret: true })) || undefined;
  saveConfig(cfg);
  if (!ready(cfg)) return false;
  return (await testConnection(true)) || (await confirm("The test failed. Keep going anyway?", false));
}

function summaryBox(title: string, ok: boolean, lines: string[]) {
  console.log("\n" + box(lines, ok ? green : red, ok ? green(title) : red(title)));
}

const gitStat = (dir: string) => new Promise<string>((res) => execFile("git", ["-C", dir, "diff", "--stat"], (e, out) => res(e ? "" : out.trim())));

// ------------------------------------------------------------------ screens
const tryOpen = (url: string) => execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], () => {});

type CodeJob = { dir: string; task: string; verify?: string; bundle?: string; selfExtend: boolean; mcpCmd?: string; live: boolean; resume: boolean; canResume: boolean };
type Edit = { path: string; diff: string; added: number; removed: number; created: boolean };
const checkpointOf = (dir: string) => join(dir, ".amness/checkpoint.json");
const untilde = (p: string) => resolve(p.replace(/^~/, homedir()));
const oneLine = (s: string, n = 70) => { const l = s.split("\n")[0]; return l.length > n || s.includes("\n") ? l.slice(0, n - 1) + "…" : l; };

/** Defaults for a directory: remembered verify command → auto-detected one; and whether an interrupted run is waiting. */
function applyDir(job: CodeJob, dir: string) {
  job.dir = dir;
  const st = loadState();
  job.verify = (st.verifyByDir[dir] ?? detectVerify(dir)) || undefined;
  job.canResume = existsSync(checkpointOf(dir)); job.resume = job.canResume;
}

/** One summary card instead of a chain of questions: everything has a sensible default, change only what you care about. */
async function plan(job: CodeJob): Promise<boolean> {
  for (;;) {
    console.log("\n" + box([
      `${dim("task       ")} ${oneLine(job.task || "(continue the bundle's task)")}`,
      `${dim("directory  ")} ${job.dir}`,
      `${dim("verify     ")} ${job.verify ?? dim("none: the agent may finish without proof")}`,
      `${dim("live view  ")} ${job.live ? green("on") : "off"}    ${dim("own tools")} ${job.selfExtend ? "on" : "off"}    ${dim("mcp")} ${job.mcpCmd ?? "none"}`,
      ...(job.bundle ? [`${dim("bundle     ")} ${basename(job.bundle)}`] : []),
      ...(job.canResume ? [`${dim("interrupted")} ${job.resume ? green("will continue where it stopped") + dim(" (your task is added as a follow-up)") : "ignored: starting fresh"}`] : []),
    ], cyan, "Ready to run"));
    const act = await select("Go?", [
      { label: "▶ Start", value: "go" },
      { label: "Change directory", value: "dir", hint: job.dir },
      { label: "Change verify command", value: "verify", hint: job.verify ?? "none" },
      { label: `Live view in browser: ${job.live ? "on → off" : "off → on"}`, value: "live" },
      { label: `Let the agent define its own tools: ${job.selfExtend ? "on → off" : "off → on"}`, value: "self", hint: "each needs approval" },
      { label: "Attach an MCP server…", value: "mcp" },
      ...(job.canResume ? [{ label: job.resume ? "Start fresh instead of resuming" : "Resume the interrupted run", value: "resume" }] : []),
      { label: "Cancel", value: "cancel" },
    ]);
    if (!act || act === "cancel") return false;
    if (act === "go") return true;
    if (act === "live") job.live = !job.live;
    else if (act === "self") job.selfExtend = !job.selfExtend;
    else if (act === "resume") job.resume = !job.resume;
    else if (act === "verify") job.verify = (await ask("Verify command (blank = none)", job.verify ?? "")) || undefined;
    else if (act === "mcp") job.mcpCmd = (await ask("MCP server command (blank = none)", job.mcpCmd ?? "")) || undefined;
    else if (act === "dir") { const d = untilde(await ask("Directory", job.dir)); if (existsSync(d)) applyDir(job, d); else console.log(red(`✗ ${d} does not exist`)); }
  }
}

const pager = (text: string) => {
  if (process.stdout.isTTY && spawnSync("less", ["-V"], { stdio: "ignore" }).status === 0) spawnSync("less", ["-R"], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  else console.log(text);
};
const colorDiff = (e: Edit) => [bold(`${e.path}${e.created ? " (new)" : ""}  ${green("+" + e.added)} ${red("-" + e.removed)}`),
  ...e.diff.split("\n").filter((l) => !/^(---|\+\+\+)/.test(l)).map((l) => (l[0] === "+" ? green(l) : l[0] === "-" ? red(l) : l[0] === "@" ? cyan(l) : gray(l))), ""].join("\n");

async function runCode(job: CodeJob) {
  if (!(await plan(job))) return;
  let st = rememberTask(loadState(), job.task);
  st = { ...st, lastDir: job.dir, verifyByDir: { ...st.verifyByDir, ...(job.verify ? { [job.dir]: job.verify } : {}) } };
  saveState(st);

  const live = job.live ? await startLive({ title: basename(job.dir) }) : undefined;
  if (live) { console.log(`${cyan("●")} live view: ${bold(live.url)}`); tryOpen(live.url); }
  const mcp = job.mcpCmd ? await loadMcp(job.mcpCmd.split(" ")[0], job.mcpCmd.split(" ").slice(1)).catch((e) => (console.log(red("✗ MCP: " + e.message)), undefined)) : undefined;
  const budget = new Budget({ maxTokens: cfg.maxTokens, maxMs: 30 * 60_000 });
  const edits: Edit[] = [];
  let ac = new AbortController();
  const cp = checkpointOf(job.dir);
  const agent = createCodeAgent({
    model: makeModel(), cwd: job.dir, verify: job.verify, budget, approve, selfExtend: job.selfExtend, tools: mcp?.tools, signal: () => ac.signal,
    checkpointFile: cp, meta: { provider: cfg.provider, model: cfg.model },
    onEvent: (e) => { onEvent(e); live?.onEvent(e); if (e.kind === "edit") edits.push(e); },
  });

  /** Run one agent call with Ctrl-C = stop at the next safe point (progress is saved), twice = quit now. */
  const execute = async (go: () => Promise<RunResult>): Promise<RunResult | undefined> => {
    ac = new AbortController(); status.t0 = Date.now(); status.step = 0; status.tokens = 0;
    let hits = 0;
    const onSigint = () => { if (++hits === 1) { log(yellow("\n⏹ stopping after the current step… (Ctrl-C again quits immediately)")); ac.abort(); } else process.exit(130); };
    process.on("SIGINT", onSigint);
    try {
      const r = await go();
      const stat = await gitStat(job.dir);
      const head = r.finished ? "Done" : r.stopped === "aborted" ? "Interrupted · progress saved" : "Stopped";
      summaryBox(head, r.finished, [r.text, "", dim(`${r.steps} steps · ${budget.tokens.toLocaleString()} tokens · ${secs(Date.now() - status.t0)} this round`), ...(stat ? ["", stat] : [])]);
      if (r.finished) rmSync(cp, { force: true });   // a finished run is not "interrupted"
      return r;
    } catch (e) { summaryBox("Error", false, [(e as Error).message, "", dim("Progress was checkpointed. Run again and choose to resume.")]); return undefined; }
    finally { process.off("SIGINT", onSigint); }
  };

  console.log(`\n${dim("Working in")} ${job.dir}${job.verify ? dim("  ·  gate: ") + job.verify : ""}\n`);
  let r = await execute(() => agent.run(job.task, { resume: job.resume, bundle: job.bundle }));
  try {
    while (r) {
      const act = await select("What next?", [
        { label: "Follow up", value: "follow", hint: "keep going in the same conversation" },
        ...(edits.length ? [{ label: `Review changes (${edits.length} edit${edits.length > 1 ? "s" : ""})`, value: "diff", hint: [...new Set(edits.map((e) => e.path))].slice(0, 3).join(", ") }] : []),
        { label: "Save portable session bundle", value: "bundle", hint: "continue elsewhere, on any model" },
        { label: "Done", value: "done" },
      ], 0);
      if (!act || act === "done") break;
      if (act === "diff") pager(edits.map(colorDiff).join("\n"));
      else if (act === "follow") {
        const text = await ask("Follow-up (paste freely; enter to send)", "", { multiline: true, history: loadState().tasks });
        if (!text) continue;
        saveState(rememberTask(loadState(), text));
        const prev = r; r = (await execute(() => agent.followUp(prev, text))) ?? r;
      } else if (act === "bundle") {
        const stop = spin("writing handoff…");
        try {
          const file = join(job.dir, ".amness/sessions", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
          const { bundle } = await agent.exportBundle(r, file);
          stop();
          console.log(`${green("✓")} ${file}\n  ${dim(`${Object.keys(bundle.files).length} file(s), ${bundle.memory.length} memory note(s). Resume anywhere: amness run --bundle <file> "continue"`)}`);
        } catch (e) { stop(); console.log(red("✗ " + (e as Error).message)); }
      }
    }
  } finally { mcp?.close(); await live?.close(); }
}

function newJob(dir: string, task: string, bundle?: string): CodeJob {
  const job: CodeJob = { dir, task, bundle, selfExtend: false, live: false, resume: false, canResume: false };
  applyDir(job, dir);
  return job;
}

async function codeScreen() {
  if (!(await ensureReady())) return;
  const st = loadState();
  const dir = existsSync(st.lastDir ?? "") ? st.lastDir! : process.cwd();
  console.log(dim(`\nProject: ${dir}   (change it on the next screen)`));
  const task = await ask("What should the agent do? (paste freely; enter to continue; esc cancels)", "", { multiline: true, history: st.tasks });
  if (!task) return;
  await runCode(newJob(dir, task));
}

async function importScreen() {
  if (!(await ensureReady())) return;
  const file = untilde(await ask("Session bundle file (.json)"));
  let b;
  try { b = readBundle(file); } catch (e) { return fail((e as Error).message); }
  console.log("\n" + box([`${bold("Task")}  ${oneLine(b.task)}`, `${dim("saved")} ${b.createdAt}  ${dim("from")} ${b.from.provider ?? "?"}/${b.from.model ?? "?"}`,
    `${dim("state")} ${b.status.finished ? "finished" : "unfinished"}  ·  ${Object.keys(b.files).length} file(s)  ·  ${b.memory.length} memory note(s)`], cyan, "Session bundle"));
  const dir = untilde(await ask("Restore into directory", loadState().lastDir ?? process.cwd()));
  if (!existsSync(dir)) return fail(`${dir} does not exist`);
  const task = await ask("What should happen next? (blank = continue the original task)", "", { multiline: true });
  await runCode(newJob(dir, task, file));
}

async function memoryScreen() {
  const dir = untilde(await ask("Project directory (its .amness/memory is shown alongside your global memory)", loadState().lastDir ?? process.cwd()));
  const store = MemoryStore.forWorkspace(dir, join(home(), "memory"));
  for (;;) {
    const entries = store.list();
    const pick = await select(`Memory · ${entries.length} note(s)`, [
      ...entries.map((e) => ({ label: e.name, value: e.scope + "/" + e.name, hint: `${e.scope} · ${e.type} · ${e.description}` })),
      { label: "+ Add a note", value: "+add" }, { label: "Back", value: "+back" },
    ], entries.length);
    if (!pick || pick === "+back") return;
    try {
      if (pick === "+add") {
        const name = await ask("Name (short slug)"); if (!name) continue;
        const type = await select("Type", [{ label: "project", value: "project" as const, hint: "conventions, commands, decisions" }, { label: "user", value: "user" as const, hint: "your preferences" },
          { label: "feedback", value: "feedback" as const, hint: "corrections to the agent" }, { label: "reference", value: "reference" as const, hint: "pointers to docs/dashboards" }]);
        const scope = await select("Applies to", [{ label: "this project", value: "project" as const }, { label: "everywhere (global)", value: "global" as const }]);
        const description = await ask("One line: when is this useful?"), content = await ask("Note", "", { multiline: true });
        try { store.save({ name, type: type ?? "project", scope: scope ?? "project", description, content }); console.log(green("✓ saved")); } catch (e) { console.log(red("✗ " + (e as Error).message)); }
        continue;
      }
      const e = entries.find((x) => x.scope + "/" + x.name === pick)!;
      console.log("\n" + box([...e.content.split("\n")], cyan, `${e.name} · ${e.scope}/${e.type}`));
      if (await confirm("Delete this note?", false)) { store.forget(e.name, e.scope); console.log(green("✓ forgotten")); }
    } catch (err) { if (!(err instanceof Cancel)) throw err; }
  }
}

async function researchScreen() {
  if (!(await ensureReady())) return;
  const goal = await ask("Research question / goal");
  if (!goal) return;
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "research";
  const dir = join(home(), "research", slug);
  mkdirSync(dir, { recursive: true });
  const resume = existsSync(join(dir, ".checkpoint.json")) && (await confirm("Found an earlier run on this topic. Resume it?", true));
  if (cfg.tavilyKey) process.env.TAVILY_API_KEY = cfg.tavilyKey;
  console.log(`\n${dim("Search:")} ${cfg.tavilyKey ? "Tavily" : "DuckDuckGo (keyless, fragile)"}  ${dim("·  files:")} ${dir}\n`);
  const budget = new Budget({ maxTokens: cfg.maxTokens, maxMs: 30 * 60_000 });
  const t0 = Date.now();
  try {
    const r = await createDeepAgent({ model: makeModel(), dir, budget, approve, onEvent }).run(goal, { resume });
    summaryBox(r.finished ? "Report ready" : "Stopped", r.finished, [dim(`${r.steps} lead steps · ${budget.tokens.toLocaleString()} tokens · ${secs(Date.now() - t0)}`), dim(`saved: ${join(dir, "report.md")}`)]);
    if (r.report) console.log("\n" + r.report.split("\n").slice(0, 60).join("\n") + (r.report.split("\n").length > 60 ? dim("\n… (see file for the rest)") : ""));
  } catch (e) { summaryBox("Error", false, [(e as Error).message]); }
  await pause();
}

async function evalScreen() {
  if (!(await ensureReady())) return;
  const trials = await select("Trials per case × variant", [
    { label: "1", value: 1, hint: "quick smoke test" }, { label: "3", value: 3, hint: "recommended" }, { label: "5", value: 5, hint: "steadier numbers" },
  ], 1);
  if (!trials) return;
  const n = cases.length * 2 * trials;
  if (!(await confirm(`This runs ${n} agent sessions (up to ${cfg.maxTokens.toLocaleString()} tokens each). Continue?`, false))) return;
  const { table } = await evaluate(cases, codeVariants(makeModel(), { maxTokens: cfg.maxTokens }), {
    trials, onRow: (r) => log(`  ${r.pass ? green("PASS") : red("FAIL")} ${r.case.padEnd(22)} ${r.variant.padEnd(14)} ${dim(`${r.steps} steps · ${r.tokens} tok · ${secs(r.ms)}${r.note ? " · " + r.note : ""}`)}`),
  });
  console.log("\n" + box(table.split("\n"), cyan, bold("baseline vs full harness")));
  await pause();
}

async function demoScreen() {
  console.log(`\n${bold("Guided demo")} ${dim("— a scripted model makes the mistakes real models make. Watch the harness catch each one.")}`);
  console.log(`${dim("Task:")} ${DEMO_TASK}\n`);
  if (!(await confirm("Start?", true))) return;
  const { result, events, dir } = await runDemo({ approve, onEvent, model: withSpinner });
  const seen = new Map<string, number>();
  events.forEach((e) => seen.set(e.kind, (seen.get(e.kind) ?? 0) + 1));
  const lines = ["nudge", "repair", "denied", "rejected"].filter((k) => seen.has(k)).map((k) => `${green("✓")} ${k.padEnd(9)} ${dim(explain[k])}`);
  summaryBox(result.finished ? "Demo complete" : "Demo stopped", result.finished, [result.text, "", bold("Guards that fired:"), ...lines, "", dim(`workspace: ${dir}`)]);
  await pause();
}

async function testConnection(quiet = false): Promise<boolean> {
  const t0 = Date.now(), stop = spin("contacting model…");
  let ok = false;
  try {
    const m = await rawModel(1)([{ role: "user", content: "Reply with exactly: OK" }], []);
    stop(); ok = true;
    console.log(`${green("✓")} ${cfg.model} replied ${cyan(JSON.stringify((m.content ?? "").slice(0, 40)))} in ${secs(Date.now() - t0)}${m.usage?.total_tokens ? dim(` · ${m.usage.total_tokens} tokens`) : ""}`);
    if (!quiet) console.log(dim("  (tool-calling support is not verified by this ping; local models vary — try the guided demo or a small task)"));
  } catch (e) { stop(); console.log(`${red("✗")} ${(e as Error).message.slice(0, 300)}`); }
  if (!quiet) await pause();
  return ok;
}

async function settings() {
  for (;;) {
    const p = PROVIDERS[cfg.provider];
    const what = await select("Settings", [
      { label: "Provider", value: "provider", hint: p.label },
      { label: "Model", value: "model", hint: cfg.model },
      { label: "Base URL", value: "url", hint: cfg.baseUrl },
      { label: "API key", value: "key", hint: mask(cfg.apiKey) },
      { label: "Tavily key (better web search)", value: "tavily", hint: mask(cfg.tavilyKey) },
      ...(cfg.provider === "anthropic" || effortsFor(cfg.model).length ? [{ label: "Reasoning effort", value: "effort", hint: cfg.effort ?? "model default" }] : []),
      { label: "Token budget per run", value: "budget", hint: cfg.maxTokens.toLocaleString() },
      { label: "Test connection", value: "test" },
      { label: "Back", value: "back" },
    ]);
    if (!what || what === "back") return;
    try {
    if (what === "provider") {
      const id = await select("Provider", (Object.keys(PROVIDERS) as ProviderId[]).map((k) => ({ label: PROVIDERS[k].label, value: k, hint: PROVIDERS[k].baseUrl })));
      if (id) Object.assign(cfg, { provider: id, baseUrl: PROVIDERS[id].baseUrl, model: PROVIDERS[id].model });
    }
    else if (what === "model") {
      if (cfg.provider === "anthropic" || cfg.provider === "openai") {
        const pick = await select(cfg.provider === "anthropic" ? "Claude model" : "OpenAI model", [...(cfg.provider === "anthropic" ? CLAUDE_MODELS : OPENAI_MODELS).map((m) => ({ label: m.id, value: m.id, hint: m.hint })), { label: "Other…", value: "" }]);
        cfg.model = pick === undefined ? cfg.model : pick || (await ask("Model id", cfg.model)) || cfg.model;
        if (cfg.provider === "openai" && cfg.effort && !effortsFor(cfg.model).includes(cfg.effort)) cfg.effort = undefined;
      } else cfg.model = (await ask("Model", cfg.model)) || cfg.model;
    }
    else if (what === "effort") {
      const levels = cfg.provider === "anthropic" ? (["low", "medium", "high", "xhigh", "max"] as const) : effortsFor(cfg.model);
      const pick = await select("Reasoning effort (higher = better on hard tasks, more tokens)", [{ label: "model default", value: "" }, ...levels.map((e) => ({ label: e, value: e as string }))]);
      if (pick !== undefined) cfg.effort = (pick || undefined) as typeof cfg.effort;
    }
    else if (what === "url") cfg.baseUrl = (await ask("Base URL", cfg.baseUrl)) || cfg.baseUrl;
    else if (what === "key") cfg.apiKey = (await ask("API key (hidden; stored in ~/.amness/config.json, mode 600)", cfg.apiKey ?? "", { secret: true })) || undefined;
    else if (what === "tavily") cfg.tavilyKey = (await ask("Tavily API key (blank to clear)", "", { secret: true })) || undefined;
    else if (what === "budget") cfg.maxTokens = Math.max(1000, Number(await ask("Max tokens per run", String(cfg.maxTokens))) || cfg.maxTokens);
    else if (what === "test") { saveConfig(cfg); await testConnection(); continue; }
    } catch (e) { if (!(e instanceof Cancel)) throw e; continue; }
    saveConfig(cfg);
  }
}

// ------------------------------------------------------------------ chat TUI
const VERSION: string = (() => { for (const rel of ["../package.json", "../../package.json"]) { try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version; } catch { /* the built copy sits one folder deeper */ } } return "0.0.0"; })();
const TOP_HELP = `amness ${VERSION}: coding agent for your terminal

  amness                       start a conversation (chat TUI)
  amness "fix the failing test"   start with a prompt
  amness -c                    continue the most recent conversation here
  amness --resume <id>         continue a specific conversation
  amness -p "task" [flags]     one-shot, non-interactive (same as: amness run)
  amness run [flags] "task"    headless mode for CI/scripts (amness run --help)
  amness menu                  the classic menu (demo, evals, research, settings…)
  amness --worktree [name]     work in a fresh git worktree on its own branch (your checkout stays untouched)
  amness --inline | --full     choose the interface (default: full-screen; AMNESS_UI or /ui also work)
  amness eval [flags]          compare harness variants statistically (amness eval --help)
  amness bench [flags]         compare Amness, Claude Code and Codex on the same tasks (amness bench --help)
  amness plugin new <name>     scaffold a plugin (guardrails, loop rules, tools, commands) (amness plugin --help)
  amness schedule <cmd>        recurring headless runs through cron (amness schedule --help)
  amness acp                   serve the Agent Client Protocol on stdio for editors (Zed, JetBrains)
  amness tune [flags]          find guard settings that hold up on unseen tasks (amness tune --help)
  amness demo                  guided demo, no API key needed

  inside the chat: /help for commands · @file to mention files · shift+tab to change permissions`;

/** amness traces [--dir d] [--case name --task "..." --check "cmd" [--verify "cmd"]]: failure report from the session traces, or snapshot the repo into an eval task. */
function traces(args: string[]): number {
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; }, dir = resolve(val("--dir") ?? join(".amness", "traces"));
  const name = val("--case");
  if (name) {
    if (!val("--task") || !val("--check")) { console.error('usage: amness traces --case <name> --task "what to do" --check "<command that exits 0 only when the task is really done>" [--verify "<command the agent may run>"]'); return 2; }
    const r = caseFromWorkspace(process.cwd(), { name, task: val("--task")!, check: val("--check")!, verify: val("--verify") });
    console.log(`${green("✓")} wrote ${r.path}  (${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB, from git HEAD)\n${dim("run it: amness eval --cases " + dirname(r.path) + " --variants ab --trials 3  ·  add a \"solution\" to the JSON to include it in --selftest")}`); return 0;
  }
  console.log(formatMining(dir)); return 0;
}

/** amness replay <trace.jsonl>: run a recorded session through the current harness (no model, no tools) and show what behaves differently. */
async function runReplay(args: string[]): Promise<number> {
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; }, file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
  if (!file) { console.error("usage: amness replay <trace.jsonl> [--off guard,guard] [--stagnation-turns n] [--max-steps n] [--context-budget chars]\n  Traces are written to .amness/traces/ (full messages are recorded in chat sessions and headless runs with --trace)."); return 2; }
  try {
    const o: Record<string, unknown> = {}; if (val("--off")) o.off = val("--off")!.split(","); if (val("--stagnation-turns")) o.stagnationTurns = Number(val("--stagnation-turns")); if (val("--max-steps")) o.maxSteps = Number(val("--max-steps")); if (val("--context-budget")) o.contextBudget = Number(val("--context-budget"));
    const reports = await replayFile(resolve(file), o); console.log(formatReplay(reports)); return reports.every((r) => r.same) ? 0 : 1;
  } catch (e) { console.error(red("✗ " + (e as Error).message)); return 2; }
}

async function startChat(argv: string[]) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("amness chat needs an interactive terminal. For scripts use: amness run [flags] \"task\""); process.exitCode = 2; return; }
  let resume: string | undefined;
  const rest: string[] = [];
  const envUi = process.env.AMNESS_UI === "inline" || process.env.AMNESS_UI === "full" ? process.env.AMNESS_UI : undefined;
  let ui: "full" | "inline" | undefined = envUi ?? cfg.ui, wtName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c" || argv[i] === "--continue") resume = "last";
    else if (argv[i] === "--resume") resume = argv[++i] ?? "last";
    else if (argv[i] === "--worktree") wtName = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : `session-${new Date().toISOString().slice(5, 16).replace(/\D/g, "")}`;
    else if (argv[i] === "--inline") ui = "inline";
    else if (argv[i] === "--full") ui = "full";
    else rest.push(argv[i]);
  }
  if (!(await ensureReady())) return;
  let wt: Awaited<ReturnType<typeof createSessionWorktree>> | undefined;
  if (wtName) {
    if (!(await isRepo(process.cwd()))) { console.error(red("✗ --worktree needs a git repository with at least one commit")); process.exitCode = 2; return; }
    try { wt = await createSessionWorktree(process.cwd(), wtName); process.chdir(wt.dir); console.log(dim(`worktree ${wt.dir} on branch ${wt.branch} (your main checkout is untouched)`)); } catch (e) { console.error(red("✗ " + (e as Error).message)); process.exitCode = 2; return; }
  }
  const tiny = (process.stdout.columns ?? 80) < 60 || (process.stdout.rows ?? 24) < 14;
  if (process.env.TERM === "dumb" || tiny) ui = "inline";
  const app = new App({ cfg, cwd: process.cwd(), version: VERSION, resume, ui: ui ?? "full", prompt: rest.join(" ").trim() || undefined });
  process.exitCode = await app.start();
  if (wt) {
    process.chdir(wt.repo);
    if (await worktreeIsUntouched(wt.dir, wt.base)) { await removeWorktree({ dir: wt.dir, repo: wt.repo }); execFileSync("git", ["branch", "-D", wt.branch], { cwd: wt.repo, stdio: "ignore" }); console.log(dim(`worktree ${wt.branch} had no changes: removed`)); }
    else console.log(`${green("✓")} work is in ${wt.dir} on branch ${bold(wt.branch)}\n${dim(`merge it with: git merge ${wt.branch}   ·   remove it with: git worktree remove ${wt.dir}`)}`);
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const argv = process.argv.slice(2), quick = argv[0];
  const screens: Record<string, () => Promise<unknown>> = { code: codeScreen, memory: memoryScreen, import: importScreen, research: researchScreen, eval: evalScreen, demo: demoScreen, settings };
  if (quick === "--version" || quick === "-v") return void console.log(VERSION);
  if (quick === "--help" || quick === "-h" || quick === "help") return void console.log(TOP_HELP);
  if (quick === "eval" && argv.length > 1) { process.exitCode = await runEval(argv.slice(1), { model: makeModel, modelFor: (id) => createModel({ ...cfg, model: id }), maxTokens: cfg.maxTokens, confirm }); return; }
  if (quick === "bench") { process.exitCode = await runBench(argv.slice(1), { confirm, amnessCli: fileURLToPath(import.meta.url) }); return; }
  if (quick === "plugin") { process.exitCode = await runPlugin(argv.slice(1)); return; }
  if (quick === "schedule") { process.exitCode = runSchedule(argv.slice(1)); return; }
  if (quick === "acp") { if (argv.includes("--help")) return void console.log(ACP_HELP); process.exitCode = await runAcp({ model: rawModel, version: VERSION, maxTokens: cfg.maxTokens }); return; }
  if (quick === "tune") { process.exitCode = await runTune(argv.slice(1), { model: makeModel, modelName: cfg.model, maxTokens: cfg.maxTokens, confirm }); return; }
  if (quick === "traces") { process.exitCode = traces(argv.slice(1)); return; }
  if (quick === "replay") { process.exitCode = await runReplay(argv.slice(1)); return; }
  if (quick === "run") { process.exitCode = await runHeadless(argv.slice(1)); return; }
  if (quick === "-p" || quick === "--print") { process.exitCode = await runHeadless(argv.slice(1)); return; }
  if (quick && quick in screens) return void (await screens[quick]().catch((e) => { if (!(e instanceof Cancel)) throw e; }));
  if (quick !== "menu") return startChat(argv);
  let keep = false;
  for (;;) {
    if (!keep) clearScreen();
    keep = false;
    banner();
    const noKey = !ready(cfg);
    const hint = noKey ? yellow("needs API key") : "";
    const choice = await select("What do you want to do?", [
      { label: "Code agent", value: "code", hint: hint || "fix or build in a repo · approvals · test gate" },
      { label: "Research agent", value: "research", hint: hint || "plans, delegates, searches the web, cites sources" },
      { label: "Guided demo", value: "demo", hint: "no API key · watch every guard catch a mistake" },
      { label: "Evals: baseline vs harness", value: "eval", hint: hint || "measure what the guards are worth" },
      { label: "Memory", value: "memory", hint: "see, add, or delete what the agent remembers" },
      { label: "Import session", value: "import", hint: hint || "continue a portable bundle · any machine or model" },
      { label: "Settings", value: "settings", hint: noKey ? "set your API key here" : "provider · model · keys · budget" },
      { label: "Quit", value: "quit" },
    ]);
    if (!choice || choice === "quit") return void console.log(dim("bye\n"));
    try { await screens[choice](); } catch (e) { if (e instanceof Cancel) { console.log(dim("cancelled")); keep = true; } else throw e; }
  }
}

// Exit as soon as output is flushed: idle keep-alive HTTP sockets would otherwise hold the process open for seconds after "Quit".
main().catch((e) => { console.error(red("fatal: " + (e?.stack ?? e))); process.exitCode = 1; })
  .finally(() => process.stdout.write("", () => process.exit(process.exitCode ?? 0)));

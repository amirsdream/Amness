// Non-interactive mode for CI, scripts and containers:  amness run [flags] "task"
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Budget, Tracer, Hooks, Permissions, projectConfigFingerprint, createCodeAgent, startLive, loadPlugins, readImage, visionLikely, bestOfN, parallelParts, isRepo, type Approve, type Event } from "../src/index.ts";
import { PROVIDERS, loadConfig, ready, type ProviderId } from "./config.ts";
import { formatEvent } from "./format.ts";
import { createModel } from "./model.ts";

export const HELP = `usage: amness run [flags] "task"
  --cwd <dir>          workspace (default .)
  --verify <cmd>       command that must exit 0 before the agent may finish
  --trust-project      run this project's .amness/hooks.json and plugins and honour its allow rules (they execute code; off by default in headless runs)
  --sandbox <mode>     run shell commands under an OS sandbox: workspace (write only in the project and temp folders) or strict (also no network)
  --review             an independent reviewer writes acceptance criteria first and checks the work before it is accepted (extra model calls)
  --trace <file>       write a JSONL trace of every loop event (also AMNESS_OTLP=<collector url> for OpenTelemetry export)
  --approval-reviewer  a second model looks at each risky call first and approves clearly safe ones (without --yes, calls it does not clear are still denied)
  --check <cmd>        fast command run after every edit; failures are shown to the agent immediately
  --provider <id>      ${Object.keys(PROVIDERS).join(" | ")}    --model <id>    --base-url <url>    --effort none|low|medium|high|xhigh|max   --api auto|responses|chat
  --bundle <file>      continue from a portable session bundle (any provider/model)
  --export <file>      write a portable session bundle when done
  --yes                auto-approve risky commands (default: deny them)
  --json               machine-readable: one JSON event per line on stdout, final {"kind":"result"} line
  --live [port]        serve the live browser view
  --best-of <n>        attempt the task up to n times in separate git worktrees (stops at the first attempt that passes --verify, which is required); the winner is applied
  --parts <file.json>  run independent parts ([{"name","task"}]) concurrently in worktrees, merged one at a time through --verify; conflicts are reported, not applied
  --image <file>       show the model a picture (png, jpg, gif, webp; up to 5 MB, repeat the flag for more, max 4); needs a vision-capable model
  --max-tokens <n>     hard token cap (default 300000)      --no-memory   disable memory
  -                    as the task: read it from standard input (useful on Windows, where quoting a long task is painful)
exit code: 0 finished, 1 not finished, 2 usage/config error`;

export async function runHeadless(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }       // asking for help must never start a model run
  const args = [...argv];
  const val = (f: string) => { const i = args.indexOf(f); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const bool = (f: string) => { const i = args.indexOf(f); return i >= 0 && !!args.splice(i, 1); };
  const cfg = loadConfig();
  const provider = val("--provider") as ProviderId | undefined;
  if (provider) {
    if (!(provider in PROVIDERS)) { console.error(`unknown provider ${provider}\n${HELP}`); return 2; }
    Object.assign(cfg, { provider, baseUrl: PROVIDERS[provider].baseUrl, model: PROVIDERS[provider].model });
    const k = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    cfg.apiKey = k ?? (loadConfig().provider === provider ? loadConfig().apiKey : undefined);
  }
  cfg.model = val("--model") ?? cfg.model;
  cfg.baseUrl = val("--base-url") ?? cfg.baseUrl;
  cfg.api = (val("--api") as typeof cfg.api) ?? cfg.api;
  cfg.effort = (val("--effort") as typeof cfg.effort) ?? cfg.effort;
  const cwd = resolve(val("--cwd") ?? "."), verify = val("--verify"), check = val("--check"), bundle = val("--bundle"), exportTo = val("--export");
  const trustHooks = bool("--trust-project") || bool("--trust-hooks"), yes = bool("--yes"), json = bool("--json"), noMemory = bool("--no-memory");
  const li = args.indexOf("--live"); let livePort: number | undefined;
  if (li >= 0) { const nxt = args[li + 1]; livePort = /^\d+$/.test(nxt ?? "") ? Number(args.splice(li, 2)[1]) : (args.splice(li, 1), 0); }
  const imagePaths: string[] = []; for (let v = val("--image"); v !== undefined; v = val("--image")) imagePaths.push(v);
  const maxTokens = Number(val("--max-tokens") ?? cfg.maxTokens);
  let task = args.join(" ").trim();
  if (task === "-") task = (await new Promise<string>((res) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); })).trim();      // `amness run -` reads the task from stdin (no quoting problems on any shell)
  if (!task && !bundle) { console.error(HELP); return 2; }
  if (!ready(cfg)) { console.error(`no API key for ${PROVIDERS[cfg.provider].label}. Set ${cfg.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} or run \`amness settings\`.`); return 2; }

  if (imagePaths.length && !visionLikely(cfg.provider, cfg.model)) { console.error(`${cfg.model} does not look like a vision model; pick one that accepts images or drop --image`); return 2; }
  let images; try { images = imagePaths.map((p) => readImage(resolve(p))); } catch (e) { console.error((e as Error).message); return 2; }
  const live = livePort === undefined ? undefined : await startLive({ port: livePort });
  if (live) console.error(`live view: ${live.url}`);
  const approve: Approve = yes ? () => true : () => "non-interactive run: risky commands are denied unless --yes is passed";
  const budget = new Budget({ maxTokens });
  const model = createModel(cfg);
  const bestOf = Number(val("--best-of") ?? 0), partsFile = val("--parts");
  if (bestOf || partsFile) {
    if (!verify) { console.error("--best-of and --parts need --verify <cmd>: that command is what decides which result is kept"); return 2; }
    if (!(await isRepo(cwd))) { console.error("--best-of and --parts need a git repository with at least one commit"); return 2; }
    try {
      if (bestOf) {
        const r = await bestOfN({ repo: cwd, n: bestOf, verify, apply: true, maxTokens, attempt: async (dir) => { const b = new Budget({ maxTokens: Math.max(1, Math.floor(maxTokens / bestOf)) }); const a = createCodeAgent({ model, cwd: dir, verify, approve, sandbox: cfg.sandbox, memory: false, budget: b }); const x = await a.run(task); await a.procs?.dispose(); return { tokens: b.tokens, summary: x.text }; }, onCandidate: (c) => console.error(`attempt ${c.index + 1}: ${c.passed ? "passed verify" : c.error ? "error: " + c.error : "failed verify"} (${c.tokens} tokens)`) });
        if (json) console.log(JSON.stringify({ kind: "result", finished: !!r.winner, applied: r.applied, tokens: r.tokens, attempts: r.candidates.length })); else console.log(r.winner ? `attempt ${r.winner.index + 1} won and was ${r.applied ? "applied" : "NOT applied: " + r.applyError}\n${r.winner.summary ?? ""}` : `no attempt passed ${verify} (${r.candidates.length} tried, ${r.tokens} tokens)`);
        return r.winner && r.applied ? 0 : 1;
      }
      const parts = JSON.parse(readFileSync(resolve(partsFile!), "utf8")) as { name: string; task: string }[];
      const { results, tokens } = await parallelParts({ repo: cwd, parts, verify, maxTokens, attempt: async (p, dir) => { const b = new Budget({ maxTokens: Math.max(1, Math.floor(maxTokens / parts.length)) }); const a = createCodeAgent({ model, cwd: dir, verify, approve, sandbox: cfg.sandbox, memory: false, budget: b }); const x = await a.run(p.task); await a.procs?.dispose(); return { tokens: b.tokens, summary: x.text }; }, onPart: (r) => console.error(`${r.part.name}: ${r.status}${r.detail ? " - " + r.detail.split("\n")[0] : ""}`) });
      if (json) console.log(JSON.stringify({ kind: "result", tokens, parts: results.map((r) => ({ name: r.part.name, status: r.status })) })); else for (const r of results) console.log(`${r.status.padEnd(14)} ${r.part.name}`);
      return results.every((r) => r.status === "merged") ? 0 : 1;
    } catch (e) { console.error("error: " + (e as Error).message); return 1; }
  }
  const tracer = val("--trace") || process.env.AMNESS_OTLP ? new Tracer({ file: val("--trace") ? resolve(val("--trace")!) : undefined, otlp: process.env.AMNESS_OTLP, sessionId: `run-${Date.now()}`, model: cfg.model }) : undefined;
  const loadedPlugins = await loadPlugins(cwd, { trustProject: trustHooks });
  for (const w of loadedPlugins.warnings) console.error("plugin: " + w);
  if (loadedPlugins.untrusted) console.error(`note: ${loadedPlugins.untrusted.count} project plugin file(s) in .amness/plugins were not loaded; pass --trust-project to run them`);
  const agent = createCodeAgent({
    model, modelById: (id) => createModel({ ...cfg, model: id }), cwd, verify, plugins: loadedPlugins.plugins.length ? loadedPlugins.plugins : undefined, check, approve, record: !!tracer || undefined, sandbox: (val("--sandbox") as "off" | "workspace" | "strict" | undefined) ?? cfg.sandbox, review: bool("--review") || undefined, approvalReviewer: bool("--approval-reviewer") || undefined, hooks: ((h) => { if (!trustHooks && projectConfigFingerprint(cwd)) console.error("note: ignoring the project's hooks and allow rules (pass --trust-project to use them)"); return h.count() ? h : undefined; })(Hooks.load(cwd, { trustProject: trustHooks })), rules: Permissions.load(cwd, { trustProject: trustHooks }), budget, memory: noMemory ? false : undefined, meta: { provider: cfg.provider, model: cfg.model },
    onEvent: (e: Event) => { live?.onEvent(e); tracer?.event(e); if (json) console.log(JSON.stringify(e)); else { const l = formatEvent(e); if (l) console.error(l); } },
  });
  try {
    const r = await agent.run(task, { bundle, images });
    if (exportTo) { await agent.exportBundle(r, exportTo); console.error(`session bundle: ${exportTo}`); }
    const out = { kind: "result", finished: r.finished, text: r.text, steps: r.steps, tokens: budget.tokens, stopped: r.stopped };
    if (json) console.log(JSON.stringify(out)); else console.log(r.text);
    return r.finished ? 0 : 1;
  } catch (e) {
    if (json) console.log(JSON.stringify({ kind: "error", message: (e as Error).message })); else console.error("error: " + (e as Error).message);
    return 1;
  } finally { await agent.procs?.dispose(); await tracer?.close(); await live?.close(); }
}

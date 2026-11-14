// Non-interactive mode for CI, scripts and containers:  amness run [flags] "task"
import { readFileSync, writeFileSync } from "node:fs";
const VERSION: string = (() => { for (const rel of ["../package.json", "../../package.json"]) { try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version; } catch { /* the built copy sits one folder deeper */ } } return "0.0.0"; })();
import { join, resolve } from "node:path";
import { cachedModel } from "../src/respcache.ts";
import { promptPlugin, harnessCard, quarantineReader, Budget, Tracer, Hooks, Permissions, projectConfigFingerprint, createCodeAgent, startLive, setShell, loadPlugins, importPlugins, loadProfile, GUARD_NAMES, applySandboxEngine, modelJudge, rolloutSummary, withEarlier, type Guard, type Profile, readImage, visionLikely, bestOfN, parallelParts, isRepo, type Approve, type Event } from "../src/index.ts";
import { McpHub } from "../src/mcp.ts";
import { cliEntries, hubOptions, mcpEntries } from "./mcpconfig.ts";
import { PROVIDERS, keyFor, loadConfig, ready, useServer, windowFor, type ProviderId } from "./config.ts";
import { detectWindow } from "./models.ts";
import { wireModels, type Wired } from "./roles.ts";
import { finishBackground, startBackground } from "./bgrun.ts";
import { formatEvent } from "./format.ts";
import { estimateCost } from "./tui/pricing.ts";
import { createModel, nativeAdvisor } from "./model.ts";

export const HELP = `usage: amness run [flags] "task"
  --cwd <dir>          workspace (default .)
  --verify <cmd>       command that must exit 0 before the agent may finish
  --trust-project      run this project's .amness/hooks.json, plugins and .mcp.json servers and honour its allow rules (they execute code; off by default in headless runs)
  --mcp-config <file|json>  MCP servers for this run ({"mcpServers": {…}}, repeatable); --strict-mcp-config uses only these; --no-mcp none
  --quarantine         dual LLM: untrusted tool output (web pages, MCP servers) is read by a separate model call with no tools; the agent sees only its digest
  --sandbox-engine <name>  which engine runs sandboxed commands: auto (Seatbelt/Bubblewrap), docker (AMNESS_SANDBOX_IMAGE, AMNESS_SANDBOX_RUNTIME=runsc for gVisor), or a plugin's
  --sandbox <mode>     run shell commands under an OS sandbox: workspace (write only in the project and temp folders) or strict (also no network)
  --review             an independent reviewer writes acceptance criteria first and checks the work before it is accepted (extra model calls)
  --trace <file>       write a JSONL trace of every loop event (also AMNESS_OTLP=<collector url> for OpenTelemetry export)
  --approval-reviewer  a second model looks at each risky call first and approves clearly safe ones (without --yes, calls it does not clear are still denied)
  --check <cmd>        fast command run after every edit; failures are shown to the agent immediately
  --provider <id>      ${Object.keys(PROVIDERS).join(" | ")}    --model <id>    --base-url <url>    --effort none|low|medium|high|xhigh|max   --api auto|responses|chat
  --bundle <file>      continue from a portable session bundle (any provider/model)
  --export <file>      write a portable session bundle when done
  --yes                auto-approve risky commands (default: deny them)
  --json               machine-readable: one JSON event per line on stdout: first {"kind":"config"} (the settings in effect), last {"kind":"result"}
  --live [port]        serve the live browser view
  --best-of-all        with --best-of: run all n attempts (not one at a time until one passes), then pick among the passing ones with a tournament of short model comparisons
  --best-of <n>        attempt the task up to n times in separate git worktrees (stops at the first attempt that passes --verify, which is required); the winner is applied
  --parts <file.json>  run independent parts ([{"name","task"}]) concurrently in worktrees, merged one at a time through --verify; conflicts are reported, not applied
  --image <file>       show the model a picture (png, jpg, gif, webp; up to 5 MB, repeat the flag for more, max 4); needs a vision-capable model
  --max-tokens <n>     hard token cap (default 300000)      --no-memory   disable memory
  --plans              offer the plan of a similar finished task, and keep plans of finished tasks (.amness/plans)
  --cache              answer identical model requests from .amness/cache/responses (reruns and replays cost nothing; use a fixed temperature)
  --server <name>      use a server saved with /provider (its address, model and key)
  --max-time <seconds> a wall-clock limit: the agent is told to wrap up near the end and stops cleanly at it (the result line says "stopped":"time")
  --tool-choice <auto|required>  required: the model must call a tool every step (the server constrains the output to a valid call); default from the model's profile
  --thinking-budget <n>  most thinking tokens per model request, for local servers that support it (llama.cpp); 0 = no thinking; default from the model's profile
  --keep-thinking      send the model's earlier thinking back with the history (local thinking models; Qwen keeps it with preserve_thinking); default from the model's profile
  --request <json>     extra fields for every model request, e.g. '{"temperature":0.6}'; merged over the profile's "request"
  --off <guard,...>    switch these guards off for this run (for ablations; see /harness for the names)
  --plugin <file,...>  load these plugin files for this run (no trust prompt: you named them)
  --add-dir <path>     let the file tools use this folder outside the project too (repeatable; without it, outside paths are refused)
  --explore-model <ref> --compact-model <ref> --review-model <ref> --cheap-model <ref> --approve-model <ref> --quarantine-model <ref>
                       a model for one role: a bare id (main provider), provider:model (anthropic:claude-haiku-5-5), or server:<name>[/model]; default from config "models"
  --local-weight <0-1> how much a token of a local-tier model counts against --max-tokens (default 1); 0.1 lets free local workers read a lot
  --stable-tools       keep the tool list the same all run: tools found with tool_search run through call_tool, so the prompt cache survives
  --background         start the run and return at once: it goes on in its own git worktree (--here: in this folder); follow it with amness tasks
  --explore-ranges     the explorer answers with file ranges that are checked against the files (ANSWER / FILES), not prose
  --subagents          offer the task tool (explorer and custom subagents); on by itself when --explore-model or models.explore is set
  --advisor-model <ref> a stronger model to consult: with a Claude main model and a Claude advisor, Anthropic's advisor tool; otherwise
                       the generic advisor (an advise tool, plus advice before the first change, when stuck, and before finishing)
  --ladder <ref,ref,…> the recovery ladder: models cheapest first; the run starts at --ladder-start (default 0), reflects, starts again
                       from a note, or moves up a model when trouble adds up, and back down after a clean stretch
  --fallback <ref>     answer from this model when the main one is overloaded or unreachable      --router   route exploration steps to --cheap-model when it pays off
  --max-steps <n>      most model turns (default 40)        --context-window <tokens>   the model's window (8192 for a small local model); default: learned from the provider
  -                    as the task: read it from standard input (useful on Windows, where quoting a long task is painful)
exit code: 0 finished, 1 not finished, 2 usage/config error`;

/** The options of `amness run` (keep in step with HELP). Anything else in the arguments is the task. */
export const VALUE_FLAGS = new Set(["--cwd", "--mcp-config", "--verify", "--check", "--bundle", "--export", "--trace", "--sandbox", "--sandbox-engine", "--provider", "--model", "--base-url", "--effort", "--api", "--best-of", "--parts", "--image", "--max-tokens",
  "--server", "--add-dir", "--max-steps", "--context-window", "--max-time", "--off", "--plugin", "--tool-choice", "--thinking-budget", "--request", "--local-weight", "--explore-model", "--compact-model", "--review-model", "--cheap-model", "--approve-model", "--quarantine-model", "--advisor-model", "--fallback", "--ladder", "--ladder-start"]);   // --live takes an optional port: it is read on its own, before the task
export const BOOL_FLAGS = new Set(["--trust-project", "--strict-mcp-config", "--no-mcp", "--trust-hooks", "--review", "--approval-reviewer", "--yes", "--json", "--no-memory", "--plans", "--cache", "--best-of-all", "--quarantine", "--keep-thinking", "--router", "--subagents", "--explore-ranges", "--stable-tools", "--background", "--here"]);

export async function runHeadless(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }       // asking for help must never start a model run
  if (argv.includes("--background")) return startBackground(argv);
  const args = [...argv];
  // Every option is taken out of the arguments before the task text is built (what is left is the task), even when the code reads it much later.
  // Before, an option read after that point (--trace, --off, --max-time…) or only looked up with argv.includes (--cache, --plans…) became part of the task.
  const taken = new Map<string, string[]>(), flagsOf = (f: string) => taken.get(f) ?? [];
  for (let i = 0; i < args.length; ) {
    const f = args[i];
    if (VALUE_FLAGS.has(f) && i + 1 < args.length) { taken.set(f, [...flagsOf(f), args[i + 1]]); args.splice(i, 2); }
    else if (BOOL_FLAGS.has(f)) { taken.set(f, [...flagsOf(f), "1"]); args.splice(i, 1); }
    else i++;
  }
  /** The next value of a value option (repeatable ones give one per call), or undefined. */
  const val = (f: string) => { const l = taken.get(f); return l?.length ? l.shift() : undefined; };
  const bool = (f: string) => !!taken.get(f)?.length;
  const cfg = loadConfig();
  const provider = val("--provider") as ProviderId | undefined;
  if (provider) {
    if (!(provider in PROVIDERS)) { console.error(`unknown provider ${provider}\n${HELP}`); return 2; }
    Object.assign(cfg, { provider, baseUrl: PROVIDERS[provider].baseUrl, model: PROVIDERS[provider].model });
    const k = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    cfg.apiKey = k ?? keyFor(provider).key;
  }
  const server = val("--server"), baseUrl = val("--base-url");
  if (server) { const s = cfg.servers?.find((x) => x.name === server); if (!s) { console.error(`no saved server named "${server}" (saved: ${(cfg.servers ?? []).map((x) => x.name).join(", ") || "none"}; add one with /provider)`); return 2; } useServer(cfg, s); }
  else if (provider || baseUrl) { cfg.server = undefined; if (!provider) cfg.apiKey = keyFor(cfg.provider).key; }   // an address given here must not get a saved server's key
  cfg.model = val("--model") ?? cfg.model;
  cfg.baseUrl = baseUrl ?? cfg.baseUrl;
  cfg.api = (val("--api") as typeof cfg.api) ?? cfg.api;
  cfg.effort = (val("--effort") as typeof cfg.effort) ?? cfg.effort;
  const addDirs: string[] = []; for (let d = val("--add-dir"); d; d = val("--add-dir")) addDirs.push(resolve(d));   // repeatable
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
  const lw = val("--local-weight"), localWeight = lw !== undefined ? Number(lw) : cfg.budgetLocalWeight;
  if (localWeight !== undefined && !(localWeight >= 0 && localWeight <= 1)) { console.error(`--local-weight must be between 0 and 1, not ${lw}`); return 2; }
  const budget = new Budget({ maxTokens, tierWeights: localWeight !== undefined ? { local: localWeight } : undefined });
  const make = (c: typeof cfg) => (bool("--cache") ? cachedModel(createModel(c), { dir: join(cwd, ".amness", "cache", "responses"), salt: `${c.provider}|${c.baseUrl}|${c.model}|${c.effort ?? ""}` }) : createModel(c));
  for (const r of ["explore", "compact", "review", "cheap", "approve", "quarantine", "advisor"] as const) { const v = val(`--${r}-model`); if (v) cfg.models = { ...cfg.models, [r]: v }; }
  { const f = val("--fallback"); if (f) cfg.fallback = f; if (bool("--router")) cfg.router = true; const l = val("--ladder"); if (l) cfg.ladder = l.split(",").map((x) => x.trim()).filter(Boolean); const ls = val("--ladder-start"); if (ls !== undefined) cfg.ladderStart = Number(ls); }
  if (cfg.router && !cfg.models?.cheap) { console.error("--router needs a cheap model (--cheap-model <ref>, or models.cheap in the config)"); return 2; }
  let wired: Wired; try { wired = wireModels(cfg, make(cfg), make, { cwd, onFallback: () => console.error(`${cfg.model} is unavailable; answering from ${cfg.fallback}`) }); } catch (e) { console.error((e as Error).message); return 2; }
  const model = wired.model;
  const loadedPlugins = await loadPlugins(cwd, { trustProject: trustHooks });
  for (const f of (val("--plugin") ?? "").split(",").filter(Boolean)) { const r = await importPlugins(resolve(f)); for (const w of r.warnings) console.error("plugin: " + w); loadedPlugins.plugins.push(...r.plugins); }   // named on the command line: you chose them, so no trust prompt
  const bestOf = Number(val("--best-of") ?? 0), partsFile = val("--parts");
  if (bestOf || partsFile) {
    if (!verify) { console.error("--best-of and --parts need --verify <cmd>: that command is what decides which result is kept"); return 2; }
    if (!(await isRepo(cwd))) { console.error("--best-of and --parts need a git repository with at least one commit"); return 2; }
    try {
      if (bestOf) {
        // Each attempt after a failure starts from what the failed ones did; with several passing attempts (--best-of-all), a tournament of short comparisons picks one.
        const select = loadedPlugins.plugins.find((p) => p.select)?.select;
        const r = await bestOfN({ repo: cwd, n: bestOf, verify, apply: true, maxTokens, parallel: bool("--best-of-all"),
          judge: select ? (g) => select(g.map((c) => ({ summary: rolloutSummary(c), diff: c.diff }))) : modelJudge(model, task),
          attempt: async (dir, _i, earlier) => { const b = new Budget({ maxTokens: Math.max(1, Math.floor(maxTokens / bestOf)) }); const a = createCodeAgent({ model, cwd: dir, verify, approve, sandbox: cfg.sandbox, memory: false, budget: b }); const x = await a.run(withEarlier(task, earlier)); await a.procs?.dispose(); return { tokens: b.tokens, summary: x.text }; }, onCandidate: (c) => console.error(`attempt ${c.index + 1}: ${c.passed ? "passed verify" : c.error ? "error: " + c.error : "failed verify"} (${c.tokens} tokens)`) });
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
  setShell(cfg.shell);
  { const e = val("--sandbox-engine"); if (e) cfg.sandboxEngine = e; }
  if (!applySandboxEngine(cfg, (m) => console.error(m))) return 2;
  // The model's profile (~/.amness/profile.json, then the project's .amness/profile.json): settings tuned per model, as in the chat app; flags win.
  let prof: Profile = {}, profSources: string[] = []; try { const lp = loadProfile(cwd, cfg.model); prof = lp.profile; profSources = lp.sources; } catch (e) { console.error(`profile ignored: ${(e as Error).message}`); }
  const off = [...new Set([...(prof.off ?? []), ...(val("--off") ?? "").split(",").map((x) => x.trim()).filter(Boolean)])] as Guard[];
  // Per-call settings: the flags are passed to the loop; the profile's own values travel on each model's card (src/card.ts), so a role model on another server keeps its own.
  const toolChoiceFlag = val("--tool-choice") as "auto" | "required" | undefined, toolChoice = toolChoiceFlag ?? prof.toolChoice;
  if (toolChoice && toolChoice !== "auto" && toolChoice !== "required") { console.error(`--tool-choice must be auto or required, not ${toolChoice}`); return 2; }
  const tb = val("--thinking-budget"), thinkingBudgetFlag = tb !== undefined ? Number(tb) : undefined, thinkingBudget = thinkingBudgetFlag ?? prof.thinkingBudget;
  if (thinkingBudget !== undefined && !(Number.isInteger(thinkingBudget) && thinkingBudget >= 0)) { console.error(`--thinking-budget must be a whole number of tokens (0 or more), not ${tb}`); return 2; }
  const keepThinkingFlag = bool("--keep-thinking") || undefined, keepThinking = keepThinkingFlag || prof.keepThinking || undefined;
  let requestFlag: Record<string, unknown> | undefined; const rq = val("--request");
  if (rq !== undefined) { try { const j = JSON.parse(rq); if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object"); requestFlag = j; } catch (e) { console.error(`--request must be a JSON object: ${(e as Error).message}`); return 2; } }
  const request = prof.request || requestFlag ? { ...prof.request, ...requestFlag } : undefined;
  { const bad = off.filter((g) => !GUARD_NAMES.includes(g)); if (bad.length) { console.error(`unknown guard ${bad.join(", ")} (guards: ${GUARD_NAMES.join(", ")})`); return 2; } }
  if (prof.prompt) { try { loadedPlugins.plugins.push(promptPlugin(cwd, prof.prompt)); } catch (e) { console.error(`the model profile's prompt "${prof.prompt}" is ignored: ${(e as Error).message}`); } }
  for (const w of loadedPlugins.warnings) console.error("plugin: " + w);
  if (loadedPlugins.untrusted) console.error(`note: ${loadedPlugins.untrusted.count} project plugin file(s) in .amness/plugins were not loaded; pass --trust-project to run them`);
  // --max-time: a wall-clock limit (benchmarks kill an agent at theirs). Near the end the agent is told to wrap up; at the limit it stops cleanly, so the result line is still written.
  const maxTime = Number(val("--max-time")) || 0, stop = new AbortController(), steer: string[] = [], timers: ReturnType<typeof setTimeout>[] = [];
  if (maxTime > 0) {
    const warnAt = Math.max(0, Math.min(maxTime * 0.8, maxTime - 120));
    timers.push(setTimeout(() => steer.push(`Time is almost up: about ${Math.round(maxTime - warnAt)} seconds are left of ${maxTime}. Stop exploring. Make sure what you changed is saved and works, then finish: say what you did and what is left.`), warnAt * 1000));
    timers.push(setTimeout(() => stop.abort(), maxTime * 1000));
  }
  const subagents = bool("--subagents") || !!wired.roles.explore;
  const usage = { prompt: 0, completion: 0, cached: 0, requests: 0 };              // every model request, subagents included, for the result line (benchmarks read it)
  const contextWindow = Number(val("--context-window")) || windowFor(cfg) || await detectWindow({ provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
  const maxSteps = Number(val("--max-steps")) || prof.maxSteps || undefined, sandbox = (val("--sandbox") as "off" | "workspace" | "strict" | undefined) ?? cfg.sandbox;
  // The settings in effect, as the first line of --json: an evaluation records what it really ran (version, guards, limits), not only what it asked for.
  if (json) console.log(JSON.stringify({ kind: "config", version: VERSION, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl ?? null, effort: cfg.effort ?? null, contextWindow: contextWindow ?? null,
    maxSteps: maxSteps ?? 40, maxTime: maxTime || null, guardsOff: off, guardsOn: GUARD_NAMES.filter((g) => !off.includes(g)), toolChoice: toolChoice ?? "auto", thinkingBudget: thinkingBudget ?? null, keepThinking: !!keepThinking, request: request ?? null,
    profile: { sources: profSources, stagnationTurns: prof.stagnationTurns ?? null, contextBudget: prof.contextBudget ?? null }, sandbox: sandbox ?? null, plugins: loadedPlugins.plugins.map((p) => p.name ?? "plugin"),
    roles: wired.labels, tier: wired.model.card?.tier ?? null, router: !!cfg.router, subagents, verify: verify ?? null, memory: !noMemory, quarantine: !!(bool("--quarantine") || cfg.quarantine),
    harnessCard: harnessCard({ version: VERSION, model: { provider: cfg.server ? `server:${cfg.server}` : cfg.provider, id: cfg.model, tier: wired.model.card?.tier, window: contextWindow ?? null, profileSources: profSources }, roles: wired.labels, router: !!cfg.router, fallback: wired.labels.fallback,
      maxSteps: maxSteps ?? 40, maxTime: maxTime || null, maxTokens, off, toolChoice: toolChoice ?? "auto", textToolCalls: !!wired.model.card?.caps?.textToolCalls, thinkingBudget: thinkingBudget ?? null, keepThinking: !!keepThinking, subagents, plugins: loadedPlugins.plugins.map((p) => p.name ?? "plugin"),
      sandbox: sandbox ?? null, sandboxEngine: cfg.sandboxEngine ?? null, quarantine: !!(bool("--quarantine") || cfg.quarantine), verify: verify ?? null, review: bool("--review"), approvalReviewer: bool("--approval-reviewer"), trace: !!tracer, memory: !noMemory }) }));
  const agent = createCodeAgent({
    advisor: nativeAdvisor(cfg) ? "native" : wired.advisor, ladder: wired.ladder, subagents, exploreRanges: bool("--explore-ranges") || cfg.exploreRanges || undefined, stableTools: bool("--stable-tools") || cfg.stableTools || undefined,
    dirs: addDirs.length ? () => addDirs : undefined,
    plans: bool("--plans") || cfg.plans || undefined,
    contextWindow,
    maxSteps, off: off.length ? off : undefined, toolChoice: toolChoiceFlag, thinkingBudget: thinkingBudgetFlag, request: requestFlag, keepThinking: keepThinkingFlag, quarantine: bool("--quarantine") || cfg.quarantine ? (wired.quarantine ? quarantineReader(wired.quarantine) : true) : undefined, stagnationTurns: prof.stagnationTurns, contextBudget: prof.contextBudget, signal: stop.signal, inbox: () => steer.splice(0),
    model, models: wired.roles, modelById: (id) => wired.byRef(id), cwd, verify, plugins: loadedPlugins.plugins.length ? loadedPlugins.plugins : undefined, check, approve, record: !!tracer || undefined, sandbox, review: bool("--review") || undefined, approvalReviewer: bool("--approval-reviewer") ? (wired.approve ? { model: wired.approve } : true) : undefined, hooks: ((h) => { if (!trustHooks && projectConfigFingerprint(cwd)) console.error("note: ignoring the project's hooks and allow rules (pass --trust-project to use them)"); return h.count() ? h : undefined; })(Hooks.load(cwd, { trustProject: trustHooks })), rules: Permissions.load(cwd, { trustProject: trustHooks }), budget, memory: noMemory ? false : undefined, meta: { provider: cfg.provider, model: cfg.model },
    onEvent: (e: Event) => { if (e.kind === "turn") { usage.prompt += e.prompt; usage.completion += e.completion; usage.cached += e.cached; usage.requests++; } live?.onEvent(e); tracer?.event(e); if (json) console.log(JSON.stringify(e)); else { const l = formatEvent(e); if (l) console.error(l); } },
  });
  const mcpExtra: string[] = []; for (let v = val("--mcp-config"); v !== undefined; v = val("--mcp-config")) mcpExtra.push(v);
  const mcp = new McpHub(hubOptions(cwd, { warn: (m) => console.error(`MCP: ${m}`) }));
  if (!bool("--no-mcp")) {
    let extra; try { extra = cliEntries(mcpExtra, cwd); } catch (e) { console.error(`--mcp-config: ${(e as Error).message}`); return 2; }
    const { entries, notes } = mcpEntries(cwd, { trusted: trustHooks, extra, strict: bool("--strict-mcp-config") });
    for (const n of notes) console.error(`note: ${n}`);
    const pend = entries.filter((e) => e.pending); if (pend.length) console.error(`note: MCP server(s) ${pend.map((e) => e.name).join(", ")} from .mcp.json not started; pass --trust-project to start them`);
    await mcp.start(entries);
    for (const r of mcp.rows()) {
      if (r.status === "failed" || r.status === "needs-login") console.error(`MCP ${r.name}: ${r.error}`);
      if (r.changed.length) console.error(`MCP ${r.name}: ${r.changed.map((c) => c.tool).join(", ")} changed since you approved the server and are left out (amness mcp approve ${r.name})`);
      for (const [tool, w] of Object.entries(r.warnings)) console.error(`MCP ${r.name}: the description of ${tool} looks suspicious: ${w.join("; ")}`);
    }
    agent.registry.add(...mcp.tools());
  }
  try {
    const r = await agent.run(task, { bundle, images });
    if (exportTo) { await agent.exportBundle(r, exportTo); console.error(`session bundle: ${exportTo}`); }
    const out = { kind: "result", finished: r.finished, text: r.text, steps: r.steps, tokens: budget.tokens, stopped: stop.signal.aborted && r.stopped === "aborted" ? "time" : r.stopped, model: cfg.model, usage, cost: estimateCost(cfg.model, usage.prompt, usage.completion, usage.cached),
      ...(Object.keys(budget.byModel).length > 1 && { byModel: budget.byModel, byTier: budget.byTier }) };
    if (json) console.log(JSON.stringify(out)); else console.log(r.text);
    finishBackground({ finished: r.finished, text: r.text, steps: r.steps, tokens: budget.tokens, stopped: r.stopped });
    return r.finished ? 0 : 1;
  } catch (e) {
    if (json) console.log(JSON.stringify({ kind: "error", message: (e as Error).message })); else console.error("error: " + (e as Error).message);
    finishBackground({ finished: false, text: `error: ${(e as Error).message}` });
    return 1;
  } finally { mcp.close(); for (const t of timers) clearTimeout(t); await agent.procs?.dispose(); await tracer?.close(); await live?.close(); }
}

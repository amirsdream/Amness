// Non-interactive mode for CI, scripts and containers:  amness run [flags] "task"
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Budget, Tracer, Hooks, Permissions, projectConfigFingerprint, createCodeAgent, startLive, type Approve, type Event } from "../src/index.ts";
import { PROVIDERS, loadConfig, ready, type ProviderId } from "./config.ts";
import { formatEvent } from "./format.ts";
import { createModel } from "./model.ts";

export const HELP = `usage: amness run [flags] "task"
  --cwd <dir>          workspace (default .)
  --verify <cmd>       command that must exit 0 before the agent may finish
  --trust-project      run this project's .amness/hooks.json and honour its allow rules (hooks execute commands; off by default in headless runs)
  --trace <file>       write a JSONL trace of every loop event (also AMNESS_OTLP=<collector url> for OpenTelemetry export)
  --check <cmd>        fast command run after every edit; failures are shown to the agent immediately
  --provider <id>      ${Object.keys(PROVIDERS).join(" | ")}    --model <id>    --base-url <url>    --effort none|low|medium|high|xhigh|max   --api auto|responses|chat
  --bundle <file>      continue from a portable session bundle (any provider/model)
  --export <file>      write a portable session bundle when done
  --yes                auto-approve risky commands (default: deny them)
  --json               machine-readable: one JSON event per line on stdout, final {"kind":"result"} line
  --live [port]        serve the live browser view
  --max-tokens <n>     hard token cap (default 300000)      --no-memory   disable memory
exit code: 0 finished, 1 not finished, 2 usage/config error`;

export async function runHeadless(argv: string[]): Promise<number> {
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
  const maxTokens = Number(val("--max-tokens") ?? cfg.maxTokens);
  const task = args.join(" ").trim();
  if (!task && !bundle) { console.error(HELP); return 2; }
  if (!ready(cfg)) { console.error(`no API key for ${PROVIDERS[cfg.provider].label}. Set ${cfg.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} or run \`amness settings\`.`); return 2; }

  const live = livePort === undefined ? undefined : await startLive({ port: livePort });
  if (live) console.error(`live view: ${live.url}`);
  const approve: Approve = yes ? () => true : () => "non-interactive run: risky commands are denied unless --yes is passed";
  const budget = new Budget({ maxTokens });
  const model = createModel(cfg);
  const tracer = val("--trace") || process.env.AMNESS_OTLP ? new Tracer({ file: val("--trace") ? resolve(val("--trace")!) : undefined, otlp: process.env.AMNESS_OTLP, sessionId: `run-${Date.now()}`, model: cfg.model }) : undefined;
  const agent = createCodeAgent({
    model, cwd, verify, check, approve, hooks: ((h) => { if (!trustHooks && projectConfigFingerprint(cwd)) console.error("note: ignoring the project's hooks and allow rules (pass --trust-project to use them)"); return h.count() ? h : undefined; })(Hooks.load(cwd, { trustProject: trustHooks })), rules: Permissions.load(cwd, { trustProject: trustHooks }), budget, memory: noMemory ? false : undefined, meta: { provider: cfg.provider, model: cfg.model },
    onEvent: (e: Event) => { live?.onEvent(e); tracer?.event(e); if (json) console.log(JSON.stringify(e)); else { const l = formatEvent(e); if (l) console.error(l); } },
  });
  try {
    const r = await agent.run(task, { bundle });
    if (exportTo) { await agent.exportBundle(r, exportTo); console.error(`session bundle: ${exportTo}`); }
    const out = { kind: "result", finished: r.finished, text: r.text, steps: r.steps, tokens: budget.tokens, stopped: r.stopped };
    if (json) console.log(JSON.stringify(out)); else console.log(r.text);
    return r.finished ? 0 : 1;
  } catch (e) {
    if (json) console.log(JSON.stringify({ kind: "error", message: (e as Error).message })); else console.error("error: " + (e as Error).message);
    return 1;
  } finally { await tracer?.close(); await live?.close(); }
}

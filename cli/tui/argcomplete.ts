// Completion for the words after a slash command: `/mode ` lists the modes, `/model ` the models your provider offers, `/theme ` the themes, and so on.
// A completer returns its options now and, when it needs the network, a promise that settles when the list has been filled in (the menu refreshes then).
import { effortsFor, loadPrompts, SANDBOX_MODES, SHELL_CHOICES, STRATEGIES } from "../../src/index.ts";
import { CLAUDE_MODELS, OPENAI_MODELS } from "../config.ts";
import { fetchModels } from "../models.ts";
import { themeNames, THEMES } from "./themes.ts";
import type { App } from "./app.ts";

export type ArgOption = { value: string; detail?: string; /** more words are expected after this one: insert a space and do not submit */ more?: boolean };
export type ArgResult = { options: ArgOption[]; pending?: Promise<unknown>; /** any value is allowed (a number, a model id, a command): Enter runs what you typed unless you moved into the list; Tab still completes */ open?: boolean };

const onOff: ArgOption[] = [{ value: "on" }, { value: "off" }];
const opts = (...xs: [string, string?][]): ArgOption[] => xs.map(([value, detail]) => ({ value, detail }));

/** Known models with their hints first, then any other model the provider reports. The provider is asked once per ten minutes; until it answers, only the known models show. */
const fetched = new Map<string, { at: number; ids: string[] }>();
function modelOptions(a: App, extra: ArgOption[] = []): ArgResult {
  const known = a.cfg.provider === "anthropic" ? CLAUDE_MODELS : a.cfg.provider === "openai" ? OPENAI_MODELS : [];
  const key = `${a.cfg.provider}|${a.cfg.baseUrl}`, have = fetched.get(key), fresh = have && Date.now() - have.at < 10 * 60_000;
  const seen = new Set(known.map((m) => m.id));
  const options = [...extra, ...known.map((m) => ({ value: m.id, detail: m.hint })), ...(have?.ids ?? []).filter((id) => !seen.has(id)).map((id) => ({ value: id, detail: "from your provider" }))];
  if (fresh) return { options, open: true };
  return { options, open: true, pending: fetchModels({ provider: a.cfg.provider, baseUrl: a.cfg.baseUrl, apiKey: a.cfg.apiKey }).then((ids) => { fetched.set(key, { at: Date.now(), ids }); }) };
}

export function argOptions(a: App, cmd: string, words: string[]): ArgResult {
  const first = words.length === 0;
  const ok = (options: ArgOption[]): ArgResult => ({ options });
  switch (cmd) {
    case "mode": return first ? ok(opts(["default", "ask before edits and non-trivial commands"], ["acceptEdits", "edits are automatic, commands still ask"], ["plan", "read-only: investigate and propose a plan"], ["yolo", "never ask (dangerous)"])) : ok([]);
    case "api": return first ? ok(opts(["auto", "pick Responses for reasoning models, self-correct"], ["responses", "OpenAI Responses API"], ["chat", "Chat Completions API"])) : ok([]);
    case "effort": return first ? ok([{ value: "default", detail: "let the model decide" }, ...(a.cfg.provider === "anthropic" ? ["low", "medium", "high", "xhigh", "max"] : effortsFor(a.cfg.model)).map((e) => ({ value: e as string }))]) : ok([]);
    case "model": return first ? modelOptions(a) : ok([]);
    case "models": return first ? ok([...["explore", "compact", "review", "cheap"].map((r) => ({ value: r, detail: `model for ${r} steps`, more: true })), { value: "fallback", detail: "answer from this model when the main one is down", more: true }])
      : words.length === 1 ? modelOptions(a, [{ value: "off", detail: "use the main model" }]) : ok([]);
    case "theme": return first ? ok(themeNames().map((n) => ({ value: n, detail: THEMES[n].label }))) : ok([]);
    case "shell": return first ? ok(SHELL_CHOICES.map((n) => ({ value: n, detail: n === "auto" ? "detect from your system" : undefined }))) : ok([]);
    case "strategy": return first ? ok([...Object.keys(STRATEGIES).map((n) => ({ value: n })), { value: "off", detail: "the default loop" }]) : ok([]);
    case "prompt": return first ? ok([...loadPrompts(a.cwd).map((p) => ({ value: p.id, detail: "from .amness/prompts" })), { value: "list" }, { value: "off", detail: "the built-in prompt" }]) : ok([]);
    case "sandbox": return first ? ok(SANDBOX_MODES.map((m) => ({ value: m, detail: m === "off" ? "no isolation" : m === "workspace" ? "writes only in the project" : "no network, caches read-only" }))) : ok([]);
    case "diffmode": return first ? ok(opts(["auto"], ["stacked"], ["split"])) : ok([]);
    case "ui": return first ? ok(opts(["full", "full-screen"], ["inline", "scrolls with the terminal"])) : ok([]);
    case "mouse": case "keepwarm": case "lsp": case "approver": case "reviewer": case "router": return first ? ok(onOff) : ok([]);
    case "copy": return first ? ok(opts(["code", "the last code block"], ["all", "the whole conversation"])) : ok([]);
    case "memory": return first ? ok([...["forget", "add"].map((v) => ({ value: v, more: true })), ...["stale", "prune", "consolidate", "graph", "embeddings"].map((v) => ({ value: v }))]) : ok([]);
    case "permissions": return first ? ok([{ value: "list" }, ...["allow", "ask", "deny"].map((v) => ({ value: v, detail: `e.g. /permissions ${v} sh(npm test*)`, more: true }))]) : ok([]);
    case "branch": return first ? ok(a.session.turns.map((t, i) => ({ value: String(i + 1), detail: t.text.replace(/\s+/g, " ").slice(0, 60) }))) : ok([]);
    case "pr": return first ? ok(opts(["draft", "create it as a draft"])) : ok([]);
    case "report": return first ? ok([{ value: "case", detail: "turn the last request into an eval task", more: true }]) : ok([]);
    case "mcp": return first ? ok([{ value: "list" }, { value: "off" }]) : ok([]);
    case "budget": return first ? { options: opts(["100k"], ["300k", "the default"], ["500k"], ["1m"], ["2m"]), open: true } : ok([]);
    case "check": case "verify": return first ? { options: [{ value: "off", detail: "switch it off" }], open: true } : ok([]);
    default: return ok([]);
  }
}

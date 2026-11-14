// Completion for the words after a slash command: `/mode ` lists the modes, `/model ` the models your provider offers, `/theme ` the themes, and so on.
// A completer returns its options now and, when it needs the network, a promise that settles when the list has been filled in (the menu refreshes then).
import { effortsFor, loadPrompts, SANDBOX_MODES, SHELL_CHOICES, STRATEGIES } from "../../src/index.ts";
import { GUARDS } from "./harnessinfo.ts";
import { CLAUDE_MODELS, OPENAI_MODELS } from "../config.ts";
import { fetchModels } from "../models.ts";
import { referenceOptions } from "../roles.ts";

const ROLE_DETAIL: [string, string][] = [["explore", "read-only exploration subagent"], ["compact", "handoff notes when the context fills"], ["review", "independent reviewer"], ["cheap", "cheap tier for the router"], ["approve", "approval reviewer for risky calls"], ["quarantine", "reader of untrusted web and MCP content"], ["advisor", "a stronger model to consult"]];
import { listDrafts } from "../../src/index.ts";
import { themeNames, THEMES } from "./themes.ts";
import { settingsView, showValue } from "./settings.ts";
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
    case "models": return first ? ok([...ROLE_DETAIL.map(([r, d]) => ({ value: r, detail: d, more: true })), { value: "fallback", detail: "answer from this model when the main one is down", more: true }])
      : words.length === 1 ? ((r) => ({ ...r, options: [...r.options, ...referenceOptions(a.cfg).map((v) => ({ value: v, detail: v.startsWith("server:") ? "saved server" : "another provider" }))] }))(modelOptions(a, [{ value: "off", detail: "use the main model" }])) : ok([]);
    case "harness": return first ? ok(opts(["on", "switch a guard on"], ["off", "switch a guard off"], ["steps", "step limit"], ["stagnation", "no-progress limit"], ["budget", "context budget in characters"], ["rewrites", "cost-aware rewrites on or off"], ["reset", "back to the defaults"]).map((o) => ({ ...o, more: o.value !== "reset" })))
      : words.length === 1 && (words[0] === "on" || words[0] === "off") ? ok(GUARDS.map((g) => ({ value: g.name, detail: g.label }))) : words.length === 1 && words[0] === "rewrites" ? ok(opts(["on", ""], ["off", ""])) : ok([]);
    case "set": return first ? ok(settingsView(a, "terminal").flatMap((g) => g.items.filter((x) => x.kind !== "action").map((x) => ({ value: x.id, detail: `${x.label} · now ${showValue(x) || "—"}`, more: true }))))
      : words.length === 1 ? (() => { const s = settingsView(a, "terminal").flatMap((g) => g.items).find((x) => x.id === words[0]); return ok(s?.kind === "toggle" ? opts(["on", ""], ["off", ""]) : s?.kind === "choice" ? (s.options ?? []).map((o) => ({ value: o.value, detail: o.label })) : []); })() : ok([]);
    case "dirs": return first ? ok(opts(["add", "allow a folder outside the project (saved)"], ["remove", "take one off the list"], ["list", "show the allowed folders"]).map((o) => ({ ...o, more: o.value !== "list" })))
      : words.length === 1 && (words[0] === "remove" || words[0] === "rm") ? ok(a.allowedDirs().map((d) => ({ value: d, detail: a.savedDirs.includes(d) ? "saved" : "this session" }))) : ok([]);
    case "todos": return first ? ok(opts(["edit", "change the agent's checklist"])) : ok([]);
    case "theme": return first ? ok(themeNames().map((n) => ({ value: n, detail: THEMES[n].label }))) : ok([]);
    case "shell": return first ? ok(SHELL_CHOICES.map((n) => ({ value: n, detail: n === "auto" ? "detect from your system" : undefined }))) : ok([]);
    case "strategy": return first ? ok([...Object.keys(STRATEGIES).map((n) => ({ value: n })), { value: "off", detail: "the default loop" }]) : ok([]);
    case "prompt": return first ? ok([...loadPrompts(a.cwd).map((p) => ({ value: p.id, detail: "from .amness/prompts" })), { value: "list" }, { value: "off", detail: "the built-in prompt" }]) : ok([]);
    case "sandbox": return first ? ok(SANDBOX_MODES.map((m) => ({ value: m, detail: m === "off" ? "no isolation" : m === "workspace" ? "writes only in the project" : "no network, caches read-only" }))) : ok([]);
    case "diffmode": return first ? ok(opts(["auto"], ["stacked"], ["split"])) : ok([]);
    case "ui": return first ? ok(opts(["full", "full-screen"], ["inline", "scrolls with the terminal"])) : ok([]);
    case "mouse": case "keepwarm": case "plans": case "lsp": case "approver": case "reviewer": case "router": return first ? ok(onOff) : ok([]);
    case "copy": return first ? ok(opts(["code", "the last code block"], ["all", "the whole conversation"])) : ok([]);
    case "memory": return first ? ok([...["forget", "add"].map((v) => ({ value: v, more: true })), ...["stale", "prune", "consolidate", "graph", "embeddings"].map((v) => ({ value: v }))]) : ok([]);
    case "permissions": return first ? ok([{ value: "list" }, ...["allow", "ask", "deny"].map((v) => ({ value: v, detail: `e.g. /permissions ${v} sh(npm test*)`, more: true }))]) : ok([]);
    case "branch": return first ? ok(a.session.turns.map((t, i) => ({ value: String(i + 1), detail: t.text.replace(/\s+/g, " ").slice(0, 60) }))) : ok([]);
    case "pr": return first ? ok(opts(["draft", "create it as a draft"])) : ok([]);
    case "report": return first ? ok([{ value: "case", detail: "turn the last request into an eval task", more: true }]) : ok([]);
    case "skills": {
      if (first) return ok([["list", "all skills and which are in use"], ["show", "print a skill's instructions"], ["new", "create a skill from a template"], ["add", "install from a folder or git URL"], ["remove", "move a skill to the trash"], ["on", "switch a skill on"], ["off", "switch a skill off"], ["draft", "write a skill from this conversation (a draft you approve)"], ["drafts", "drafts waiting for approval"], ["approve", "make a draft active"], ["reject", "delete a draft"]].map(([value, detail]) => ({ value, detail, more: ["show", "new", "add", "remove", "on", "off", "approve", "reject"].includes(value) })));
      if (words.length === 1 && ["show", "remove", "rm", "on", "off"].includes(words[0])) return ok((a.agent.allSkills ?? []).filter((x) => (words[0] === "on" ? a.agent.skillState.isOff(x.name) : words[0] === "off" ? !a.agent.skillState.isOff(x.name) : true)).map((x) => ({ value: x.name, detail: x.description.slice(0, 60) })));
      if (words.length === 1 && ["approve", "reject"].includes(words[0])) return ok(listDrafts(a.cwd).map((d) => ({ value: d.name, detail: d.description.slice(0, 60) })));
      if (words.length === 1 && words[0] === "add") return { options: [], open: true };
      return ok([]);
    }
    case "mcp": return first ? ok(["list", "add", "remove", "enable", "disable", "reconnect", "tools", "approve", "off"].map((value) => ({ value }))) : ok((a.mcpHub?.rows() ?? []).map((r) => ({ value: r.name, hint: r.status })));
    case "budget": return first ? { options: opts(["100k"], ["300k", "the default"], ["500k"], ["1m"], ["2m"]), open: true } : ok([]);
    case "check": case "verify": return first ? { options: [{ value: "off", detail: "switch it off" }], open: true } : ok([]);
    default: return ok([]);
  }
}

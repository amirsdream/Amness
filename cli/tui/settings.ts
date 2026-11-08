// One list of settings for both front ends: the desktop Preferences window and the terminal /settings page draw from it, and a change runs the same code
// (most run the terminal command you would type, so there is one implementation of each). /set <id> <value> changes any of them by name.
import { join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { SHELL_CHOICES, STRATEGIES, effortsFor, loadPrompts } from "../../src/index.ts";
import { connections, home, keyIdOf, mask, windowFor } from "../config.ts";
import { loadState, saveState } from "../state.ts";
import { GUARDS, harnessView } from "./harnessinfo.ts";
import { themeNames } from "./themes.ts";
import type { App } from "./app.ts";

export type SettingValue = string | number | boolean;
export type SettingItem = {
  id: string; label: string; help: string;
  /** toggle: on/off · choice: one of `options` · text/number: typed · secret: typed and hidden (the value shown is masked) · list: entries you add and remove · action: opens a dialog at once (not staged) */
  kind: "toggle" | "choice" | "text" | "number" | "secret" | "list" | "action";
  value?: SettingValue; options?: { value: string; label: string }[]; placeholder?: string;
  entries?: { value: string; hint?: string }[]; command?: string; button?: string;
};
export type SettingGroup = { id: string; label: string; lead: string; items: SettingItem[] };
/** A list change is "add:<value>" or "remove:<value>"; every other change is the new value. */
export type SettingChange = { id: string; value: SettingValue };

type Def = Omit<SettingItem, "value" | "options" | "entries"> & {
  group: string;
  read?: (a: App) => Partial<Pick<SettingItem, "value" | "options" | "entries" | "help">> | null;   // null hides it (for this provider or front end)
  /** The command to run for a value, or a function that applies it and says what it did. */
  write?: (a: App, v: SettingValue) => string | ((a: App) => string);
  /** Only in this front end. */
  only?: "terminal" | "desktop";
};

const onoff = (v: SettingValue) => (v === true || v === "on" || v === "true" ? "on" : "off");
const num = (v: SettingValue) => { const n = Number(String(v).replace(/[_,\s]/g, "")); return Number.isFinite(n) ? n : NaN; };
const under = (p: string, d: string) => p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
const full = (a: App, p: string) => resolve(a.cwd, p.replace(/^~(?=$|[\\/])/, homedir()));

export const GROUPS: { id: string; label: string; lead: string }[] = [
  { id: "chat", label: "Chat", lead: "How conversations behave." },
  { id: "model", label: "Model", lead: "Which model answers, and how." },
  { id: "limits", label: "Context and limits", lead: "How much the agent may send and spend." },
  { id: "harness", label: "Harness", lead: "The agent loop's own checks and limits. Each guard can be switched off; together they were not measured to change the pass rate yet, so leave them on unless you are testing." },
  { id: "safety", label: "Safety & quality", lead: "What protects your machine and what checks the work." },
  { id: "folders", label: "Folders and trust", lead: "Which folders Amness may work in." },
  { id: "search", label: "Search and memory", lead: "Web search and the agent's notes." },
  { id: "advanced", label: "Advanced", lead: "Rarely needed." },
  { id: "extend", label: "Extend", lead: "Your own code and tools: plugins, hooks, skills, subagents, MCP servers, per-model profiles. Each opens its own view." },
  { id: "terminal", label: "Terminal", lead: "How the terminal app looks and types." },
];

const DEFS: Def[] = [
  // chat
  { group: "chat", id: "notify", label: "Notifications", help: "When a long turn ends or approval is needed while you are in another window.", kind: "toggle", read: (a) => ({ value: a.cfg.notify !== "off" }), write: (_, v) => `/notify ${onoff(v)}` },
  // model
  { group: "model", id: "provider", label: "Provider", help: "A cloud provider, or a server you saved (Ollama, custom).", kind: "choice",
    read: (a) => ({ value: keyIdOf(a.cfg), options: connections(a.cfg).map((c) => ({ value: c.id, label: c.server ? `${c.label} (${c.server.provider === "ollama" ? "Ollama" : "custom"})` : c.label })) }), write: (_, v) => `/provider ${v}` },
  { group: "model", id: "servers", label: "Providers, keys and servers", help: "Add or replace keys, set up a new server, change or forget a saved one.", kind: "action", command: "/connect", button: "Manage…" },
  { group: "model", id: "model", label: "Model", help: "The model id (/model lists what your provider offers).", kind: "text", read: (a) => ({ value: a.cfg.model }), write: (_, v) => `/model ${v}` },
  { group: "model", id: "effort", label: "Reasoning effort", help: "More effort thinks longer and costs more.", kind: "choice",
    read: (a) => { const l = a.cfg.provider === "anthropic" ? ["low", "medium", "high", "xhigh", "max"] : effortsFor(a.cfg.model); return l.length ? { value: a.cfg.effort ?? "default", options: [{ value: "default", label: "default" }, ...l.map((x) => ({ value: x, label: x }))] } : null; }, write: (_, v) => `/effort ${v}` },
  { group: "model", id: "fallback", label: "Fallback model", help: "Answers when the main model is overloaded or unreachable. Empty for none.", kind: "text", placeholder: "none", read: (a) => ({ value: a.cfg.fallback ?? "" }), write: (_, v) => `/models fallback ${v || "off"}` },
  ...(["explore", "compact", "review", "cheap"] as const).map((r): Def => ({ group: "model", id: `models.${r}`, label: `Model for ${r}`, kind: "text", placeholder: "same as the main model",
    help: { explore: "The read-only explorer subagents.", compact: "Handoff notes and /compact.", review: "The independent reviewer.", cheap: "Cheap steps when the router is on." }[r],
    read: (a) => ({ value: a.cfg.models?.[r] ?? "" }), write: (_, v) => `/models ${r} ${v || "off"}` })),
  { group: "model", id: "toolChoice", label: "Tool call every step", help: "Task runs (amness run, benchmarks): the model must call a tool at every step, so the server limits its output to a valid call. Helps local models that drift into prose. Saved in this model's profile (~/.amness/profile.json); the chat ignores it.", kind: "choice",
    read: (a) => ({ value: a.profile?.profile.toolChoice ?? "auto", options: [{ value: "auto", label: "auto (the model decides)" }, { value: "required", label: "required (task runs)" }] }),
    write: (_, v) => (a) => { const choice = String(v); if (choice !== "auto" && choice !== "required") throw new Error(`auto or required, not ${v}`); setProfileField(a.cfg.model, "toolChoice", choice === "auto" ? undefined : choice); a.buildAgent(); return `tool choice for ${a.cfg.model}: ${choice} (in ~/.amness/profile.json)`; } },
  { group: "model", id: "compactAt", label: "Server-side compaction", help: "OpenAI Responses only: the server compacts the conversation once the prompt passes this many tokens. Empty: off.", kind: "number", placeholder: "off",
    read: (a) => (a.cfg.provider === "openai" ? { value: a.cfg.compactAt ?? "" } : null), write: (_, v) => (a) => { const n = Math.floor(num(v)); if (v === "" || v === "off") a.cfg.compactAt = undefined; else if (n >= 1000) a.cfg.compactAt = n; else throw new Error("at least 1000 tokens"); a.saveConfig(); a.buildAgent(); return `server-side compaction ${a.cfg.compactAt ? `at ${a.cfg.compactAt.toLocaleString()} tokens` : "off"}`; } },
  { group: "model", id: "router", label: "Router", help: "Send exploration steps to the cheap model when that pays off.", kind: "toggle", read: (a) => ({ value: !!a.cfg.router }), write: (_, v) => `/router ${onoff(v)}` },
  { group: "model", id: "api", label: "Wire API", help: "OpenAI-compatible providers only.", kind: "choice", read: (a) => (a.cfg.provider === "anthropic" ? null : { value: a.cfg.api ?? "auto", options: ["auto", "responses", "chat"].map((x) => ({ value: x, label: x })) }), write: (_, v) => `/api ${v}` },
  // limits
  { group: "limits", id: "budget", label: "Budget per turn", help: "Token cap for one turn (cached input counts a tenth). For example 300k or 1m.", kind: "text", placeholder: "300k", read: (a) => ({ value: a.cfg.maxTokens }), write: (_, v) => `/budget ${v}` },
  { group: "limits", id: "contextWindow", label: "Context window", help: "The model's window in tokens, for a small or local model (8192). Empty: learned from the provider.", kind: "number", placeholder: "learned",
    read: (a) => ({ value: windowFor(a.cfg) ?? "" }), write: (_, v) => (a) => { const n = num(v); if (v === "" || v === "auto") { a.cfg.contextWindow = undefined; } else if (n >= 512) a.cfg.contextWindow = Math.floor(n); else throw new Error(`not a window size: ${v}`); a.saveConfig(); a.buildAgent(); return `context window ${a.cfg.contextWindow ? a.cfg.contextWindow.toLocaleString() + " tokens" : "learned from the provider"}`; } },
  { group: "limits", id: "maxConcurrent", label: "Requests at once", help: "Most model requests in flight, shared by the agent and its subagents. Halves on a rate limit and ramps back up.", kind: "number", placeholder: "4",
    read: (a) => ({ value: a.cfg.maxConcurrent ?? 4 }), write: (_, v) => (a) => { const n = Math.floor(num(v)); if (!(n >= 1 && n <= 64)) throw new Error(`between 1 and 64, not ${v}`); a.cfg.maxConcurrent = n; a.saveConfig(); a.buildAgent(); return `at most ${n} request${n === 1 ? "" : "s"} at once`; } },
  { group: "limits", id: "taskBudget", label: "Claude task budget", help: "Claude only: an advisory token budget per turn (at least 20000). Empty for none.", kind: "number", placeholder: "none",
    read: (a) => (a.cfg.provider === "anthropic" ? { value: a.cfg.taskBudget ?? "" } : null), write: (_, v) => (a) => { const n = Math.floor(num(v)); if (v === "" || v === "off") a.cfg.taskBudget = undefined; else if (n >= 20000) a.cfg.taskBudget = n; else throw new Error("at least 20000"); a.saveConfig(); a.buildAgent(); return `task budget ${a.cfg.taskBudget ? a.cfg.taskBudget.toLocaleString() : "off"}`; } },
  // harness
  ...GUARDS.map((g): Def => ({ group: "harness", id: `guard.${g.name}`, label: g.label, kind: "toggle", help: `${g.what} · ${g.name}`,
    read: (a) => { const x = harnessView(a.cfg, a.profile?.profile).guards.find((y) => y.name === g.name)!; return { value: x.on, help: `${g.what}${x.byProfile ? " (off in this model's profile)" : ""} · ${g.name}` }; }, write: (_, v) => `/harness ${onoff(v)} ${g.name}` })),
  { group: "harness", id: "maxSteps", label: "Step limit", help: "The most model turns in one run.", kind: "number", read: (a) => ({ value: harnessView(a.cfg, a.profile?.profile).maxSteps }), write: (_, v) => `/harness steps ${v}` },
  { group: "harness", id: "stagnationTurns", label: "No-progress limit", help: "Turns without measurable progress before the run stops.", kind: "number", read: (a) => ({ value: harnessView(a.cfg, a.profile?.profile).stagnationTurns }), write: (_, v) => `/harness stagnation ${v}` },
  { group: "harness", id: "contextBudget", label: "Context budget", help: "Characters of history before old tool output is shortened (when the model's window is not known).", kind: "number", read: (a) => ({ value: harnessView(a.cfg, a.profile?.profile).contextBudget }), write: (_, v) => `/harness budget ${v}` },
  { group: "harness", id: "governRewrites", label: "Cost-aware rewrites", help: "Shorten old output only when that saves more than the lost prompt cache costs. Not measured to help.", kind: "toggle", read: (a) => ({ value: !!a.cfg.harness?.governRewrites }), write: (_, v) => `/harness rewrites ${onoff(v)}` },
  { group: "harness", id: "harnessReset", label: "Defaults", help: "Switch every guard back on and reset the limits.", kind: "action", command: "/harness reset", button: "Reset" },
  // safety
  { group: "safety", id: "sandbox", label: "Sandbox", help: "Shell commands run in an OS sandbox: workspace (no writes outside the project) or strict (no network either).", kind: "choice", read: (a) => ({ value: a.cfg.sandbox ?? "off", options: [["off", "Off"], ["workspace", "Workspace"], ["strict", "Strict"]].map(([value, label]) => ({ value, label })) }), write: (_, v) => `/sandbox ${v}` },
  { group: "safety", id: "verify", label: "Verify command", help: "Must pass before Amness may say it is done (for example npm test). Empty for none.", kind: "text", placeholder: "none", read: (a) => ({ value: a.verify ?? "" }), write: (_, v) => `/verify ${v || "off"}` },
  { group: "safety", id: "check", label: "Check after each edit", help: "A fast command (typecheck, lint) whose failures go straight back to the model. Empty for none.", kind: "text", placeholder: "none", read: (a) => ({ value: a.check ?? "" }), write: (_, v) => `/check ${v || "off"}` },
  { group: "safety", id: "lsp", label: "Language-server errors", help: "Add errors from an installed language server to edit results.", kind: "toggle", read: (a) => ({ value: !!a.cfg.lsp }), write: (_, v) => `/lsp ${onoff(v)}` },
  { group: "safety", id: "review", label: "Independent reviewer", help: "A skeptical second pass before work is accepted (extra model calls).", kind: "toggle", read: (a) => ({ value: !!a.cfg.review }), write: (_, v) => `/reviewer ${onoff(v)}` },
  { group: "safety", id: "approvalReviewer", label: "Approval reviewer", help: "A second model pre-approves clearly safe risky calls (never the safety floor).", kind: "toggle", read: (a) => ({ value: !!a.cfg.approvalReviewer }), write: (_, v) => `/approver ${onoff(v)}` },
  { group: "safety", id: "permissions", label: "Permission rules", help: "Allow, ask and deny rules for tools and commands.", kind: "action", command: "/permissions", button: "Show…" },
  // folders and trust
  { group: "folders", id: "dirs", label: "Folders outside this project", help: "The file tools may use these too. Saved ones stay for this project; the others end with the session.", kind: "list", placeholder: "/path/to/folder",
    read: (a) => ({ entries: [...a.savedDirs.map((d) => ({ value: d, hint: "saved" })), ...a.sessionDirs.map((d) => ({ value: d, hint: "this session" }))] }),
    write: (_, v) => { const s = String(v); return s.startsWith("remove:") ? `/dirs remove ${s.slice(7)}` : `/dirs add ${s.replace(/^add:/, "")}`; } },
  { group: "folders", id: "trusted", label: "Trusted folders", help: "Folders you said you trust when Amness first opened them (and the folders inside). Remove one to be asked again.", kind: "list", placeholder: "/path/to/folder",
    read: () => ({ entries: (loadState().trustedDirs ?? []).map((d) => ({ value: d })) }),
    write: (_, v) => (a) => {
      const s = String(v), add = !s.startsWith("remove:"), d = add ? full(a, s.replace(/^add:/, "")) : s.slice(7), st = loadState();
      if (add && !(existsSync(d) && statSync(d).isDirectory())) throw new Error(`${d} is not a folder`);
      st.trustedDirs = add ? [...new Set([...(st.trustedDirs ?? []), d])] : (st.trustedDirs ?? []).filter((x) => x !== d); saveState(st);
      return add ? `trusted: ${d}` : `${d} is not trusted any more${under(resolve(a.cwd), d) ? " (this project included: you are asked again next time)" : ""}`;
    } },
  // search and memory
  { group: "search", id: "tavilyKey", label: "Tavily key", help: "Better web search (tavily.com). Kept in your system's key store. Empty removes it.", kind: "secret", placeholder: "not set",
    read: (a) => ({ value: a.cfg.tavilyKey ? mask(a.cfg.tavilyKey) : "" }), write: (_, v) => (a) => { a.cfg.tavilyKey = String(v) || undefined; a.saveConfig(); a.buildAgent(); return v ? "Tavily key saved: web search uses Tavily" : "Tavily key removed"; } },
  { group: "search", id: "embeddings", label: "Semantic memory", help: "Find notes by meaning: note text and your messages are sent to your provider's embeddings endpoint (not Claude).", kind: "toggle", read: (a) => ({ value: !!a.cfg.embeddings }), write: (_, v) => `/memory embeddings ${onoff(v)}` },
  { group: "search", id: "memory", label: "Memory notes", help: "What the agent remembered across sessions: list, add or forget notes.", kind: "action", command: "/memory", button: "Show…" },
  // advanced
  { group: "advanced", id: "shell", label: "Shell", help: "Which shell runs the agent's commands.", kind: "choice", read: (a) => ({ value: a.cfg.shell ?? "auto", options: ["auto", ...SHELL_CHOICES.filter((x) => x !== "auto")].map((x) => ({ value: x, label: x })) }), write: (_, v) => `/shell ${v}` },
  { group: "advanced", id: "strategy", label: "Loop strategy", help: "Plan first, explore then act, or none.", kind: "choice", read: (a) => ({ value: a.cfg.strategy ?? "off", options: ["off", ...Object.keys(STRATEGIES)].map((x) => ({ value: x, label: x })) }), write: (_, v) => `/strategy ${v}` },
  { group: "advanced", id: "prompt", label: "System prompt", help: "Your own system prompt from .amness/prompts/<id>.md, or the built-in one.", kind: "choice",
    read: (a) => ({ value: a.cfg.prompt ?? "built-in", options: [{ value: "built-in", label: "built-in" }, ...loadPrompts(a.cwd).map((x) => ({ value: x.id, label: x.id }))] }), write: (_, v) => `/prompt ${v === "built-in" ? "off" : v}` },
  { group: "advanced", id: "keepWarm", label: "Keep the cache warm", help: "While you are away, keep the prompt cache alive (a few cache reads).", kind: "toggle", read: (a) => ({ value: !!a.cfg.keepWarm }), write: (_, v) => `/keepwarm ${onoff(v)}` },
  { group: "advanced", id: "plans", label: "Plan cache", help: "Offer the plan of a similar finished task as a starting point.", kind: "toggle", read: (a) => ({ value: !!a.cfg.plans }), write: (_, v) => `/plans ${onoff(v)}` },
  // terminal only
  { group: "terminal", id: "theme", label: "Colour theme", help: "The terminal app's colours.", kind: "choice", only: "terminal", read: (a) => ({ value: a.cfg.theme ?? "", options: themeNames().map((x) => ({ value: x, label: x })) }), write: (_, v) => `/theme ${v}` },
  { group: "terminal", id: "ui", label: "View", help: "Full screen, or inline in your terminal's scrollback.", kind: "choice", only: "terminal", read: (a) => ({ value: a.ui === "inline" ? "inline" : "full", options: [{ value: "full", label: "full screen" }, { value: "inline", label: "inline" }] }), write: (_, v) => `/ui ${v}` },
  { group: "terminal", id: "sidebar", label: "Side panel", help: "The panel on the right of the full-screen view (Ctrl+B).", kind: "toggle", only: "terminal", read: (a) => (a.full ? { value: a.full.showSidebar } : null), write: (_, v) => (a) => { if (a.full && a.full.showSidebar !== !!v) { a.full.showSidebar = !!v; a.full.invalidate(); } return `side panel ${v ? "shown" : "hidden"}`; } },
  { group: "terminal", id: "mouse", label: "Mouse", help: "Click and scroll in the full-screen view. Off gives back the terminal's own text selection.", kind: "toggle", only: "terminal", read: (a) => (a.full ? { value: a.full.mouseOn } : null), write: (_, v) => `/mouse ${onoff(v)}` },
  { group: "terminal", id: "diffMode", label: "Diff layout", help: "How edits are shown: side by side when there is room, stacked, or split.", kind: "choice", only: "terminal", read: (a) => (a.full ? { value: a.full.diffMode, options: ["auto", "stacked", "split"].map((x) => ({ value: x, label: x })) } : null), write: (_, v) => `/diffmode ${v}` },
  { group: "terminal", id: "vim", label: "Vim keys", help: "Vim-style editing in the input box (Esc for normal mode).", kind: "toggle", only: "terminal", read: (a) => ({ value: !!a.cfg.vim }), write: (_, v) => `/vim ${onoff(v)}` },
  // extend: views of your own code and tools (each a command with its own dialog)
  { group: "extend", id: "plugins", label: "Plugins", help: "Code in .amness/plugins (and ~/.amness/plugins) that adds tools, hooks, gates, routing, memory, commands and eval graders.", kind: "action", command: "/plugins", button: "Show…" },
  { group: "extend", id: "hooks", label: "Hooks", help: "Commands that run before or after tool calls and model turns (.amness/hooks.json, ~/.amness/hooks.json).", kind: "action", command: "/hooks", button: "Show…" },
  { group: "extend", id: "skills", label: "Skills", help: "SKILL.md instructions the agent loads when a task matches: list, add, switch on or off, review drafts.", kind: "action", command: "/skills", button: "Show…" },
  { group: "extend", id: "agents", label: "Subagents", help: "Custom subagents in .amness/agents/*.md that the agent can hand work to.", kind: "action", command: "/agents", button: "Show…" },
  { group: "extend", id: "mcp", label: "MCP servers", help: "Tool servers attached to this session. Attach one with /mcp <command>.", kind: "action", command: "/mcp list", button: "Show…" },
  { group: "extend", id: "profile", label: "Model profile", help: "Settings for this model only (~/.amness/profile.json, .amness/profile.json): guards off, limits, tool choice.", kind: "action", command: "/profile", button: "Show…" },
  { group: "extend", id: "tools", label: "Tools", help: "Every tool the agent can use right now, built in and added.", kind: "action", command: "/tools", button: "Show…" },
];

/** Set (or with undefined, remove) one field of `model`'s entry in the user's profile file, keeping everything else in it. */
function setProfileField(model: string, key: "toolChoice", value: string | undefined) {
  const file = join(home(), "profile.json");
  let j: { default?: Record<string, unknown>; models?: Record<string, Record<string, unknown>> } = {};
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch { /* none yet */ }
  const entry = { ...(j.models?.[model] ?? {}) };
  if (value === undefined) delete entry[key]; else entry[key] = value;
  j.models = { ...(j.models ?? {}), [model]: entry };
  if (!Object.keys(entry).length) delete j.models[model];
  mkdirSync(home(), { recursive: true }); writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
}

const shownIn = (d: Def, front: "terminal" | "desktop") => !d.only || d.only === front;

/** Every setting with its current value, grouped, for one front end. */
export function settingsView(a: App, front: "terminal" | "desktop"): SettingGroup[] {
  return GROUPS.map((g) => ({ ...g, items: DEFS.filter((d) => d.group === g.id && shownIn(d, front)).flatMap((d) => {
    const r = d.read ? d.read(a) : {}; if (r === null) return [];
    const { read: _r, write: _w, group: _g, only: _o, ...item } = d; return [{ ...item, ...r }];
  }) })).filter((g) => g.items.length);
}

export const settingIds = () => DEFS.filter((d) => d.write).map((d) => d.id);
export const findSetting = (id: string) => DEFS.find((d) => d.id === id || d.id.toLowerCase() === id.toLowerCase());

/** Apply changes in order; a value a setting refuses is reported, not applied. `run` runs a terminal command and returns what it said (quietly in the desktop app, in the conversation in the terminal). */
export async function applySettings(a: App, changes: SettingChange[], run: (cmd: string) => Promise<string[]>): Promise<{ id: string; ok: boolean; message: string }[]> {
  const out: { id: string; ok: boolean; message: string }[] = [];
  for (const c of changes) {
    const d = findSetting(c.id);
    if (!d?.write) { out.push({ id: c.id, ok: false, message: `no setting called ${c.id}` }); continue; }
    try {
      const w = d.write(a, c.value);
      const message = typeof w === "string" ? (await run(w)).join(" ").trim() || "done" : w(a);
      // A command can refuse (no OS sandbox on this machine, an unknown model): for a switch or a choice, read it back, and report a value that did not stick
      const now = (d.kind === "toggle" || d.kind === "choice") && d.read ? d.read(a)?.value : undefined;
      const stuck = now === undefined || String(now) === String(d.kind === "toggle" ? onoff(c.value) === "on" : c.value);
      out.push({ id: c.id, ok: stuck, message: stuck ? message : `${d.label} is still ${d.kind === "toggle" ? (now ? "on" : "off") : now}${message !== "done" ? `: ${message}` : ""}` });
    } catch (e) { out.push({ id: c.id, ok: false, message: (e as Error).message }); }
  }
  return out;
}

/** What a value looks like in a list: on/off, a choice's label, or the text (empty shows the placeholder). */
export const showValue = (s: SettingItem): string => s.kind === "toggle" ? (s.value ? "on" : "off") : s.kind === "choice" ? s.options?.find((o) => o.value === String(s.value))?.label ?? String(s.value ?? "")
  : s.kind === "list" ? `${s.entries?.length ?? 0}` : s.kind === "action" ? "" : String(s.value ?? "") || s.placeholder || "";


// Slash commands. Each gets the running App and the raw argument string.
import { ROLE_NAMES, resolveConfig } from "../roles.ts";
import { bgLine } from "./background.ts";
import { formatDoctor, loadProfile, runDoctor, writeProfile } from "../../src/index.ts";
import { previewLines, relatives } from "./session.ts";
import { GUARDS, harnessView } from "./harnessinfo.ts";
import { applySettings, settingsView, showValue, type SettingChange, type SettingItem, type SettingValue } from "./settings.ts";
import { SHELL_CHOICES, STRATEGIES, chooseShell, currentShell, loadPrompts, setShell, shellFallbackNote } from "../../src/index.ts";
import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { approveDraft, fetchSource, inspectSource, installSkills, listDrafts, rejectDraft, scaffoldSkill, trashSkill } from "../../src/index.ts";
import { collectFiles, effortsFor, loadMcp, readBundle, writeBundle, type Bundle } from "../../src/index.ts";
import { CLAUDE_MODELS, OPENAI_MODELS, PROVIDERS, connections, forgetServer, keyFor, serverKey, serverName, storeKey, useServer, type Connection, type ProviderId, type Server } from "../config.ts";
import { noStore, where } from "../keystore.ts";
import { fetchModels, prefixCacheRate } from "../models.ts";
import { argOptions } from "./argcomplete.ts";
import { STAGE_GLYPH, roundOf, stagesOf } from "./looppanel.ts";
import { bold, cyan, dim, green, red, yellow } from "../ui.ts";
import type { App } from "./app.ts";
import { estimateCost, fmtCost, fmtDuration, fmtTokens } from "./pricing.ts";
import { codeBlocks } from "./clipboard.ts";
import { execFile } from "node:child_process";
import { caseFromWorkspace, commitLog, createPr, currentBranch, defaultBase, diffForReview, draftPr, hasUpstream, pushBranch, reviewWork, formatMining, Hooks, Permissions, SANDBOX_MODES, cacheWaste, pluginFingerprint, projectConfigFingerprint, sandboxHelp, sandboxKind, type SandboxMode } from "../../src/index.ts";
import { isTrustedDir, loadState, saveState } from "../state.ts";
import { tokenReport } from "./tokens.ts";
import { THEMES, getTheme, themeNames } from "./themes.ts";
import { helpLines, renderDiff, toolCall, todoList } from "./view.ts";

export type Cmd = { name: string; help: string; alias?: string; args?: string; /** safe to run while the agent is working */ live?: boolean; run(app: App, args: string): Promise<void> | void };

const INIT_PROMPT = "Explore this repository and write an AGENTS.md at the repo root for future coding sessions: what the project is, how to build/test/run it (exact commands), the code layout, conventions you can verify from the code, and gotchas. Keep it under 80 lines and do not invent anything you cannot confirm from the files.";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const keyStatus = (c: Connection) => c.source === "env" ? `${c.needsKey ? "connected" : "local · key"} · from ${c.env}` : c.source === "saved" ? (c.needsKey ? `connected · ${noStore() ? "this session only" : where()}` : `local · key ${noStore() ? "for this session only" : where()}`) : c.needsKey ? "not connected" : "local · no key (optional)";
/** A cloud provider needs a key; a server (Ollama, vLLM, llama.cpp, LM Studio…) usually does not, but one started with an API key or behind a proxy does. */
const keyPrompt = (label: string, optional: boolean) => optional ? `${label} API key or token, only if your server needs one (hidden; ${where()}; Enter skips)` : `${label} API key (hidden; ${where()})`;
const inUse = (a: App, c: Connection) => (c.server ? a.cfg.server === c.server.name : !a.cfg.server && a.cfg.provider === c.id);
const serverHint = (c: Connection) => `${c.server!.provider === "ollama" ? "Ollama" : "custom"} · ${c.server!.baseUrl.replace(/^https?:\/\//, "")} · ${c.server!.model} · ${c.source === "none" ? "no key" : c.source === "env" ? `key from ${c.env}` : "key saved"}`;
const rowOf = (a: App, c: Connection) => ({ label: `${!c.needsKey || c.source !== "none" ? "●" : "○"} ${c.label}${inUse(a, c) ? "  (in use)" : ""}`, value: c.id as string, hint: c.server ? serverHint(c) : keyStatus(c) });
const ADD_SERVER = [{ label: "+ Ollama server…", value: "+ollama", hint: "a local Ollama, or one on another machine" }, { label: "+ Custom OpenAI-compatible server…", value: "+custom", hint: "vLLM, llama.cpp, LM Studio, a gateway" }];

/** Make a cloud provider the one in use, with its saved key (or asking for one). Returns false if the user gave up. */
async function switchProvider(a: App, id: ProviderId): Promise<boolean> {
  let apiKey = keyFor(id).key;
  if (!apiKey) { apiKey = await a.askText(keyPrompt(PROVIDERS[id].label, false), { secret: true }); if (!apiKey) return false; }
  Object.assign(a.cfg, { provider: id, baseUrl: PROVIDERS[id].baseUrl, model: PROVIDERS[id].model, apiKey, server: undefined });
  a.saveConfig(); a.buildAgent(); a.say(`provider → ${cyan(PROVIDERS[id].label)}, model ${cyan(a.cfg.model)}`, dim);
  return true;
}
/** Use a saved server: its address, model and own key, with no questions. */
function useSaved(a: App, s: Server) {
  useServer(a.cfg, s); a.saveConfig(); a.buildAgent();
  a.say(`provider → ${cyan(s.name)} (${s.baseUrl}), model ${cyan(s.model)}`, dim);
}
/** Set up a server: its address, an optional key, the model (from the server's own list when it gives one) and a name. It is saved, so /provider offers it next time. */
async function addServer(a: App, kind: Server["provider"], old?: Server): Promise<boolean> {
  const label = PROVIDERS[kind].label;
  const baseUrl = (await a.askText(`${old ? old.name : label}: base URL (usually ending in /v1)`, { initial: old?.baseUrl ?? PROVIDERS[kind].baseUrl }))?.trim(); if (!baseUrl) return false;
  const had = old ? keyFor(serverKey(old.name)).key : undefined;
  const key = had ? had : (await a.askText(keyPrompt(old?.name ?? label, true), { secret: true })) || undefined;
  a.note("asking the server for its models…", 7000);
  const models = await fetchModels({ provider: kind, baseUrl, apiKey: key });
  let model: string | undefined = models.length ? await a.pick("Model", [...models.map((m) => ({ label: m, value: m, hint: "from the server" })), { label: "Other…", value: "" }], Math.max(0, models.indexOf(old?.model ?? ""))) : "";
  if (model === undefined) return false;
  if (!model) { model = (await a.askText("Model id", { initial: old?.model ?? PROVIDERS[kind].model }))?.trim(); if (!model) return false; }
  const name = old?.name ?? (await a.askText("Name for this server (you pick it by this name in /provider)", { initial: serverName(kind, baseUrl) }))?.trim(); if (!name) return false;
  if (!old && (a.cfg.servers ?? []).some((x) => x.name === name) && (await a.pick(`A server named "${name}" is saved already. Replace it?`, [{ label: "Yes, replace it", value: "y" }, { label: "No", value: "n" }])) !== "y") return false;
  useServer(a.cfg, { name, provider: kind, baseUrl, model }); if (key) a.cfg.apiKey = key;
  a.saveConfig(); a.buildAgent(); a.say(`${green("✓")} ${cyan(name)} saved and in use: ${baseUrl}, model ${cyan(model)}${key ? ", with a key" : ""}. Pick it again with /provider.`, dim);
  return true;
}

const onoffValue = (v: string, dflt: boolean) => (/^(on|true|yes|1)$/i.test(v) ? true : /^(off|false|no|0)$/i.test(v) ? false : dflt);

/** The terminal's settings page: the same groups and settings as the desktop Preferences. Changes are drafts until "Apply"; Esc with drafts asks first. */
async function settingsPage(a: App) {
  const drafts = new Map<string, SettingValue>(), lists = new Map<string, string[]>();   // list settings collect "add:x" / "remove:x" in order
  const count = () => drafts.size + [...lists.values()].reduce((n, l) => n + l.length, 0);
  const shown = (s: SettingItem) => { if (s.kind === "list") { const ops = lists.get(s.id) ?? []; return `${s.entries?.length ?? 0} folder${s.entries?.length === 1 ? "" : "s"}${ops.length ? ` → ${ops.length} change${ops.length === 1 ? "" : "s"} •` : ""}`; }
    if (!drafts.has(s.id)) return showValue(s); return `${showValue(s)} → ${showValue({ ...s, value: drafts.get(s.id)! })} •`; };
  const apply = async () => {
    const changes: SettingChange[] = [...[...drafts].map(([id, value]) => ({ id, value })), ...[...lists].flatMap(([id, ops]) => ops.map((value) => ({ id, value })))];
    const res = await applySettings(a, changes, async (cmd) => { await a.runCommand(cmd); return []; });
    for (const r of res.filter((x) => x.message !== "done")) a.say(`${r.ok ? green("✓") : red("✗")} ${r.message}`, r.ok ? dim : red);
    a.say(`${green("✓")} ${res.filter((r) => r.ok).length} of ${res.length} setting${res.length === 1 ? "" : "s"} applied`, dim); drafts.clear(); lists.clear();
  };
  for (;;) {
    const groups = settingsView(a, "terminal"), n = count();
    const g = await a.pick<string>(`Settings${n ? `   ${n} change${n === 1 ? "" : "s"} not applied yet` : ""}`, [
      ...(n ? [{ label: `Apply ${n} change${n === 1 ? "" : "s"}`, value: "@apply" }, { label: "Revert", value: "@revert", hint: "forget the changes" }] : []),   // first, so they are never below the fold
      ...groups.map((x) => ({ label: x.label, value: x.id, hint: x.items.filter((i) => drafts.has(i.id) || lists.get(i.id)?.length).length ? "changed •" : x.lead })),
    ]);
    if (g === "@apply") { await apply(); continue; }
    if (g === "@revert") { drafts.clear(); lists.clear(); continue; }
    if (!g) {
      if (!count()) return;
      const q = await a.pick(`${count()} change${count() === 1 ? "" : "s"} not applied yet`, [{ label: "Apply them", value: "apply" }, { label: "Discard them", value: "discard" }, { label: "Keep editing", value: "keep" }]);
      if (q === "apply") { await apply(); return; } if (q === "discard") return; continue;
    }
    for (;;) {
      const group = settingsView(a, "terminal").find((x) => x.id === g); if (!group) break;
      const id = await a.pick<string>(group.label, group.items.map((s) => ({ label: s.label, value: s.id, hint: s.kind === "action" ? `${s.button ?? "Open…"} ${dim(s.help)}` : `${shown(s)}  ${dim(s.help)}` })));
      if (!id) break;
      const s = group.items.find((x) => x.id === id)!;
      if (s.kind === "action") { await a.runCommand(s.command!); continue; }                   // its own dialog (keys, servers) or output, then back to this group with the drafts kept
      const cur = drafts.has(id) ? drafts.get(id)! : s.value;
      let v: SettingValue | undefined;
      if (s.kind === "toggle") v = !cur;
      else if (s.kind === "choice") v = await a.pick(s.label, s.options!.map((o) => ({ label: o.label, value: o.value, hint: o.value === String(s.value) ? "now" : undefined })), Math.max(0, s.options!.findIndex((o) => o.value === String(cur))));
      else if (s.kind === "list") {
        const ops = lists.get(id) ?? [], gone = new Set(ops.filter((o) => o.startsWith("remove:")).map((o) => o.slice(7)));
        const e = await a.pick<string>(`${s.label}: pick one to remove`, [...(s.entries ?? []).filter((x) => !gone.has(x.value)).map((x) => ({ label: x.value, value: "remove:" + x.value, hint: x.hint })), ...ops.filter((o) => o.startsWith("add:")).map((o) => ({ label: o.slice(4), value: "", hint: "to add •" })), { label: "+ Add a folder…", value: "@add" }]);
        if (e === "@add") { const p = (await a.askText(`Folder to add (${s.placeholder})`))?.trim(); if (p) lists.set(id, [...ops, "add:" + p]); }
        else if (e) lists.set(id, [...ops, e]);
        continue;
      } else v = (await a.askText(`${s.label}${s.kind === "secret" ? " (hidden; empty removes it)" : ""}`, { initial: s.kind === "secret" ? "" : String(cur ?? ""), secret: s.kind === "secret" })) ?? undefined;
      if (v === undefined) continue;
      if (v === s.value && s.kind !== "secret") drafts.delete(id); else drafts.set(id, v);   // back to the saved value: no change
    }
  }
}

export function buildCommands(): Cmd[] {
  return [
    { name: "help", alias: "?", help: "keys and commands", live: true, run: (a) => a.openPager(helpLines(a.cmds, (a.io.output.columns || 80) - 1), "help") },
    { name: "model", help: "switch model", args: "[id]", run: async (a, arg) => {
      let id: string | undefined = arg;
      if (!id) {
        const list = a.cfg.provider === "anthropic" ? CLAUDE_MODELS : a.cfg.provider === "openai" ? OPENAI_MODELS : [{ id: a.cfg.model, hint: "current" }];
        const have = new Set(list.map((m) => m.id));
        a.note("asking your provider for its models…", 7000);
        const extra = (await fetchModels({ provider: a.cfg.provider, baseUrl: a.cfg.baseUrl, apiKey: a.cfg.apiKey })).filter((m) => !have.has(m)).map((m) => ({ id: m, hint: "from your provider" }));
        const known = [...list, ...extra].map((m) => ({ label: m.id, value: m.id, hint: m.hint }));
        id = await a.pick("Model", [...known, { label: "Other…", value: "" }], Math.max(0, known.findIndex((m) => m.value === a.cfg.model)));
        if (id === undefined) return;
        if (id === "") { id = await a.askText("Model id", { initial: a.cfg.model }); if (!id) return; }
      }
      a.cfg.model = id;
      if (a.cfg.effort && a.cfg.provider !== "anthropic" && !effortsFor(id).includes(a.cfg.effort)) { a.say(`effort "${a.cfg.effort}" is not valid for ${id}; using the model default`, yellow); a.cfg.effort = undefined; }
      a.saveConfig(); a.buildAgent(); a.say(`model → ${cyan(id)}`, dim);
    } },
    { name: "provider", help: "switch provider (OpenAI, Claude, OpenRouter) or a saved server (Ollama, custom), or set up a new server; each keeps its own key", args: "[name]", run: async (a, arg) => {
      const list = connections(a.cfg);
      if (arg.trim()) {                                                              // "/provider openai", "/provider lab", "/provider server:lab"
        const q = arg.trim().toLowerCase(), c = list.find((x) => x.id.toLowerCase() === q || x.label.toLowerCase() === q || (x.server && x.server.name.toLowerCase() === q));
        if (!c) return void a.say(`no provider or saved server called "${arg.trim()}". Choose: ${list.map((x) => x.server?.name ?? x.id).join(", ")}`, red);
        return void (c.server ? useSaved(a, c.server) : await switchProvider(a, c.id as ProviderId));
      }
      const v = await a.pick<string>("Provider", [...list.map((c) => rowOf(a, c)), ...ADD_SERVER], Math.max(0, list.findIndex((c) => inUse(a, c))));
      if (!v) return;
      if (v === "+ollama" || v === "+custom") return void (await addServer(a, v.slice(1) as Server["provider"]));
      const c = list.find((x) => x.id === v)!;
      if (c.server) useSaved(a, c.server); else await switchProvider(a, c.id as ProviderId);
    } },
    { name: "dirs", alias: "add-dir", args: "[add|remove] [path]", help: "folders outside the project the agent may use: list, add (saved for this project) or remove", run: async (a, arg) => {
      let [act = "", ...rest] = arg.trim().split(/\s+/).filter(Boolean), p = rest.join(" ");
      if (act && !["add", "remove", "rm", "list"].includes(act)) { p = arg.trim(); act = "add"; }   // "/add-dir ../lib", "/dirs ../lib"
      const full = (x: string) => resolve(a.cwd, x.replace(/^~(?=$|[\\/])/, homedir()));
      if (!act || act === "list") {
        if (!a.allowedDirs().length) return void a.say("No folders outside this project are allowed. Add one with /dirs add <path>, or say yes when Amness asks for one.", dim);
        return void a.say([bold("Folders outside this project the agent may use"), ...a.savedDirs.map((d) => `  ${d}  ${dim("saved")}`), ...a.sessionDirs.map((d) => `  ${d}  ${dim("this session")}`), dim("  /dirs remove <path> takes one off")].join("\n"));
      }
      if (act === "add") {
        if (!p) p = (await a.askText("Folder to allow (absolute, or relative to the project)")) ?? ""; if (!p) return;
        const d = full(p);
        if (!existsSync(d) || !statSync(d).isDirectory()) return void a.say(`${d} is not a folder`, red);
        if (d === resolve(a.cwd) || d.startsWith(resolve(a.cwd) + sep)) return void a.say(`${d} is inside the project already`, dim);
        a.allowDir(d, true); return void a.say(`${green("✓")} the agent may use files in ${cyan(d)} (saved for this project; /dirs remove to undo)`, dim);
      }
      const d = p ? full(p) : await a.pick("Remove which folder?", a.allowedDirs().map((x) => ({ label: x, value: x, hint: a.savedDirs.includes(x) ? "saved" : "this session" })));
      if (!d) return;
      a.say(a.removeDir(d) ? `${d} removed: the agent asks again before using it` : `${d} was not on the list`, dim);
    } },
    { name: "settings", alias: "config", help: "every setting in one place, grouped as in the desktop Preferences; changes wait for Apply", run: (a) => settingsPage(a) },
    { name: "set", help: "change one setting by name: /set contextWindow 32768 (no name lists them)", args: "[setting] [value]", run: async (a, arg) => {
      const [id = "", ...rest] = arg.trim().split(/\s+/), value = rest.join(" ");
      if (!id) return void a.say([bold("Settings you can change with /set"), ...settingsView(a, "terminal").flatMap((g) => g.items.filter((x) => x.kind !== "action").map((x) => `  ${x.id.padEnd(22)} ${dim(showValue(x) || "—")}  ${dim(x.label)}`))].join("\n"));
      const d = settingsView(a, "terminal").flatMap((g) => g.items).find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (!d || d.kind === "action") return void a.say(`no setting called "${id}". /set lists them`, red);
      const v: SettingValue = d.kind === "toggle" ? onoffValue(value, !d.value) : value;
      const [r] = await applySettings(a, [{ id: d.id, value: v }], async (cmd) => { await a.runCommand(cmd); return []; });
      if (r.message !== "done") a.say(r.ok ? `${d.label}: ${r.message}` : `${d.label}: ${r.message}`, r.ok ? dim : red);
    } },
    { name: "connect", alias: "keys", help: "providers and saved servers: add, replace or remove keys; change or forget a server; add a new one", run: async (a) => {
      for (;;) {
        const list = connections(a.cfg);
        const v = await a.pick<string>("Providers and servers   ● ready   ○ needs a key", [...list.map((c) => rowOf(a, c)), ...ADD_SERVER]);
        if (!v) return;
        if (v === "+ollama" || v === "+custom") { await addServer(a, v.slice(1) as Server["provider"]); continue; }
        const c = list.find((x) => x.id === v)!, s = c.server, id = c.id;
        const act = !s && c.source === "none" ? "add" : await a.pick(`${c.label}: what do you want to do?`, [
          ...(inUse(a, c) ? [] : [{ label: s ? "Use this server now" : "Use this provider now", value: "use" }]),
          { label: c.source === "env" ? `Also save a key (${c.env} still wins while it is set)` : c.source === "saved" ? "Replace the key" : "Add a key or token", value: "add" },
          ...(c.source === "saved" ? [{ label: "Remove the saved key", value: "remove" }] : []),
          ...(s ? [{ label: "Change its address or model", value: "edit" }, { label: "Forget this server", value: "forget", hint: "and its key" }] : []),
        ]);
        if (!act) continue;
        if (act === "use") { if (s) useSaved(a, s); else await switchProvider(a, id as ProviderId); continue; }
        if (act === "edit") { await addServer(a, s!.provider, s); continue; }
        if (act === "forget") {
          const was = inUse(a, c); forgetServer(a.cfg, s!.name); a.saveConfig(); if (was) a.buildAgent();
          a.say(`${s!.name} forgotten${was ? ". It was in use: pick another with /provider" : ""}`, was ? yellow : dim); continue;
        }
        if (act === "add") {
          const key = await a.askText(keyPrompt(c.label, !!s), { secret: true });
          if (!key) continue;
          storeKey(id, key);
          if (inUse(a, c)) { a.cfg.apiKey = keyFor(id).key; a.buildAgent(); }
          a.say(`${green("✓")} ${c.label}: key saved (${noStore() ? "this session only" : where()})`, dim);
        } else {
          storeKey(id, undefined);
          if (inUse(a, c)) { a.cfg.apiKey = keyFor(id).key; a.buildAgent(); }
          a.say(`${c.label}: saved key removed`, dim);
        }
      }
    } },
    { name: "effort", help: "reasoning effort for the current model", args: "[level]", run: async (a, arg) => {
      const levels = a.cfg.provider === "anthropic" ? [...EFFORTS] : effortsFor(a.cfg.model);
      if (!levels.length) return void a.say(`${a.cfg.model} is not a reasoning model, so there is no effort setting`, yellow);
      let e: string | undefined = arg;
      if (!e) e = await a.pick("Reasoning effort", [{ label: "default", value: "default", hint: "let the model decide" }, ...levels.map((x) => ({ label: x, value: x as string, hint: x === "none" ? "no reasoning: fastest" : x === "max" ? "deepest" : undefined }))], a.cfg.effort ? Math.max(0, levels.indexOf(a.cfg.effort as never)) + 1 : 0);          // preselect what is set now, or "default"
      if (!e) return;
      if (e !== "default" && !levels.includes(e as never)) return void a.say(`"${e}" is not valid for ${a.cfg.model}. Choose: ${levels.join(", ")}`, red);
      a.cfg.effort = e === "default" ? undefined : (e as typeof a.cfg.effort); a.saveConfig(); a.buildAgent(); a.say(`effort → ${cyan(e)}`, dim);
    } },
    { name: "api", help: "OpenAI wire API: auto · responses · chat", args: "[mode]", run: async (a, arg) => {
      if (a.cfg.provider === "anthropic") return void a.say("this applies to OpenAI-compatible providers only", yellow);
      const m = arg || (await a.pick("OpenAI wire API", [{ label: "auto", value: "auto", hint: "Responses for reasoning models, Chat elsewhere; self-correcting (default)" }, { label: "responses", value: "responses", hint: "/v1/responses: required for tools + reasoning on current models" }, { label: "chat", value: "chat", hint: "/v1/chat/completions: Ollama, vLLM, most gateways" }]));
      if (!m) return;
      if (!["auto", "responses", "chat"].includes(m)) return void a.say(`unknown mode "${m}"`, red);
      a.cfg.api = m as "auto"; a.saveConfig(); a.buildAgent(); a.say(`api → ${cyan(m)}`, dim);
    } },
    { name: "mode", help: "permissions: default · acceptEdits · plan · yolo", args: "[mode]", run: async (a, arg) => {
      const m = arg || (await a.pick("Permission mode", [
        { label: "default", value: "default", hint: "ask before edits and non-trivial commands" }, { label: "acceptEdits", value: "acceptEdits", hint: "edits are automatic, commands still ask" },
        { label: "plan", value: "plan", hint: "read-only: investigate and propose a plan" }, { label: "yolo", value: "yolo", hint: "never ask (dangerous)" }]));
      if (!m) return;
      if (!["default", "acceptEdits", "plan", "yolo"].includes(m)) return void a.say(`unknown mode "${m}"`, red);
      a.setMode(m as never);
    } },
    { name: "output", alias: "last", help: "the full output of the last tool call in a pager (/output 2 for the one before)", args: "[n]", live: true, run: (a, arg) => {
      const calls = a.blocks.blocks.filter((b): b is Extract<typeof b, { kind: "tool" }> => b.kind === "tool" && (!b.agent || b.agent === "lead") && !!b.result && b.name !== "todo_write");
      if (!calls.length) return void a.say("no tool output yet", dim);
      const n = Math.max(1, Math.floor(Number(arg) || 1)), b = calls[calls.length - n];
      if (!b) return void a.say(`only ${calls.length} tool call${calls.length === 1 ? "" : "s"} so far`, dim);
      const body = b.result!.split("\n"); let head = toolCall(b.name, b.args);
      if (b.name === "sh") { try { head = `$ ${JSON.parse(b.args).cmd}`; } catch { /* keep the generic header */ } }
      a.openPager([head, "", ...body], "output");
    } },
    { name: "plan", help: "enter plan mode (read-only)", run: (a) => a.setMode("plan") },
    { name: "clear", help: "start a fresh conversation", alias: "new", run: (a) => {
      a.newConversation(); a.screen.height = 0; a.io.output.write("\x1b[2J\x1b[3J\x1b[H");
      a.commit([dim("  conversation cleared; the old one is saved (use /resume)"), ""]);
    } },
    { name: "compact", help: "summarise the conversation to free up context", run: async (a) => {
      if (!a.session.messages.length) return void a.say("nothing to compact yet", dim);
      a.note("compacting…", 60_000);
      const r = await a.agent.compact(a.session.messages);
      a.session.messages = r.messages; a.lastPrompt = 0; a.saveSession(); a.noticeUntil = 0; a.rebuildBlocks();
      a.commit(["", `  ${green("✓")} ${dim("conversation compacted into a handoff note")}`, ...r.note.split("\n").slice(0, 8).map((l) => "    " + dim(l))]);
    } },
    { name: "memory", help: "list notes · forget <name> · add <text> · stale · prune · consolidate · graph · embeddings", args: "[forget|add|stale|prune|consolidate|graph|embeddings]", run: async (a, arg) => {
      const m = a.memory; if (!m) return void a.say("memory is disabled", yellow);
      const [sub, ...rest] = arg.split(/\s+/), tail = rest.join(" ");
      if (sub === "forget" && tail) return void a.say(m.forget(tail) ? `forgot ${tail}` : `no note named ${tail}`, dim);
      if (sub === "add" && tail) return a.remember(tail);
      if (sub === "embeddings") {
        if (tail !== "on" && tail !== "off") return void a.say(`semantic memory search is ${a.cfg.embeddings ? "on" : "off"}. /memory embeddings on|off`, dim);
        if (tail === "on" && a.cfg.provider === "anthropic") return void a.say("Claude has no embeddings endpoint. Switch the provider to an OpenAI-compatible one (/provider), or keep keyword search.", yellow);
        a.cfg.embeddings = tail === "on"; a.saveConfig(); a.buildAgent();
        return void a.say(tail === "on" ? "semantic memory search on: note text and your messages are sent to your provider's /embeddings endpoint (stored vectors live in memory/embeddings.json)" : "semantic memory search off", dim);
      }
      if (sub === "graph") { const all = m.list(), rows = all.map((e) => [e, m.neighbors(e, all)] as const).filter(([, n]) => n.length); return void a.commit(rows.length ? ["", bold("  Related notes"), ...rows.map(([e, n]) => `  ${cyan(e.name.padEnd(24))} ${dim("↔")} ${n.map((x) => x.name).join(", ")}`), dim("  links come from [[name]] mentions and from notes that keep being retrieved together")] : ["", dim("  no links yet. Mention [[other-note]] in a note, or keep using memory: notes retrieved together get linked.")]); }
      if (sub === "consolidate") {
        a.say("asking the model to tidy memory (merge duplicates, archive obsolete notes)…", dim);
        const plan = await m.consolidate(a.roles.compact ?? a.model);
        if (!plan.merges.length && !plan.archive.length) return void a.say("memory looks tidy: nothing to merge or archive", dim);
        const lines = [...plan.merges.map((x) => `merge ${x.from.join(", ")} → ${x.keep}`), ...plan.archive.map((n) => `archive ${n}`)];
        a.commit(["", bold("  Proposed memory clean-up"), ...lines.map((l) => "  " + l), dim("  nothing is deleted: replaced notes move to memory/archive/")]);
        const ok = await a.pick("Apply this clean-up?", [{ label: "Yes, apply", value: "y" }, { label: "No", value: "n" }]);
        if (ok === "y") { const r = m.applyPlan(plan); a.say(`merged ${r.merged}, archived ${r.archived}`, dim); }
        return;
      }
      if (sub === "stale") { const st = m.stale(); return void a.commit(st.length ? ["", bold("  Never-used notes (older than 90 days, surfaced at most once)"), ...st.map((e) => `  ${cyan(e.name.padEnd(24))} ${dim(`[${e.scope}/${e.type}] last used ${e.used ?? e.updated}`)}`), dim("  /memory prune moves them to an archive folder (reversible)")] : ["", dim("  no stale notes")]); }
      if (sub === "prune") { const gone = m.prune(); return void a.say(gone.length ? `archived ${gone.length} stale note${gone.length === 1 ? "" : "s"}: ${gone.join(", ")} (moved to memory/archive/)` : "nothing stale to archive", dim); }
      const all = m.list();
      if (!all.length) return void a.say("no memory notes yet. Use `# note` or ask me to remember something.", dim);
      a.commit(["", bold("  Memory"), ...all.map((e) => `  ${cyan(e.name.padEnd(24))} ${dim(`[${e.scope}/${e.type}]${e.hits ? ` · used ${e.hits}×` : ""}`)} ${e.description}`)]);
    } },
    { name: "resume", help: "continue an earlier conversation", alias: "sessions", run: async (a) => {
      const list = a.store.list().filter((s) => s.id !== a.session.id);
      if (!list.length) return void a.say("no earlier conversations in this project", dim);
      const seen = new Map<string, string[]>(), preview = (id: string) => { let v = seen.get(id); if (!v) { const s = a.store.load(id); v = s ? previewLines(s) : []; seen.set(id, v); } return v; };
      const id = await a.pick("Resume (type to search)", list.map((s) => ({ label: s.title || "(untitled)", value: s.id, hint: `${s.turns} turns · ${s.updated.slice(0, 16).replace("T", " ")} · ${s.model}` })), 0, undefined, preview);
      const s = id && a.store.load(id); if (!s) return;
      a.loadSession(s); a.rebuildBlocks(); a.commit(["", `  ${green("↻")} ${dim(`resumed "${s.title}" (${s.turns.length} turns)`)}`]);
    } },
    { name: "rename", help: "name this conversation (find it in /resume, or start with: amness chat --resume <name>)", args: "<name>", run: (a, arg) => {
      const name = arg.trim().replace(/\s+/g, " "); if (!name) return void a.say(`this conversation is called "${a.session.title || "(untitled)"}". /rename <name> to change it`, dim);
      a.session.title = name.slice(0, 80); a.saveSession(); a.full?.invalidate(); a.say(`renamed to "${a.session.title}"`, dim);
    } },
    { name: "branch", help: "fork the conversation from an earlier turn (the current one stays available in /branches)", args: "[turn]", run: async (a, arg) => {
      if (a.running) return void a.say("wait for the current turn to finish", dim);
      if (!a.session.turns.length) return void a.say("nothing to branch from yet", dim);
      const n = arg.trim() ? Number(arg) : await a.pick("Branch after turn…", a.session.turns.map((t, i) => ({ label: `${i + 1}. ${t.text.replace(/\s+/g, " ").slice(0, 60)}`, value: i + 1 })).reverse());
      if (!n || !Number.isInteger(n) || n < 1 || n > a.session.turns.length) return void a.say(`give a turn number from 1 to ${a.session.turns.length}`, dim);
      await a.branchAfter(n - 1);
    } },
    { name: "branches", help: "switch between branches of this conversation", run: async (a) => {
      const all = a.store.list().map((i) => a.store.load(i.id)!).filter(Boolean); if (a.session.turns.length) all.push(a.session);
      const ids = new Set(relatives(Array.from(new Map(all.map((s) => [s.id, s])).values()), a.session.id)); const list = a.store.list().filter((s) => ids.has(s.id) && s.id !== a.session.id);
      if (!list.length) return void a.say("this conversation has no other branches (/branch forks one)", dim);
      const id = await a.pick("Branches", list.map((s) => ({ label: s.title || "(untitled)", value: s.id, hint: `${s.turns} turns · ${s.updated.slice(0, 16).replace("T", " ")}` })));
      const s = id && a.store.load(id); if (!s) return;
      a.loadSession(s); a.rebuildBlocks(); a.commit(["", `  ${green("↻")} ${dim(`switched to "${s.title}" (${s.turns.length} turns)`)}`, dim("  files are not swapped: they stay as they are now. Use /rewind or git if this branch expects different files.")]);
    } },
    { name: "export", help: "save a portable session bundle", args: "[file]", run: async (a, arg) => {
      if (!a.session.turns.length) return void a.say("nothing to export yet", dim);
      a.note("writing handoff…", 60_000);
      const file = resolve(a.cwd, arg || join(".amness", "sessions", `${a.session.id}.json`));
      const touched = new Set(a.edits.map((e) => e.path));
      const { bundle } = await a.agent.exportBundle({ messages: a.session.messages, finished: true, text: a.session.title }, undefined);
      bundle.files = collectFiles(a.cwd, touched);
      writeBundle(file, bundle); a.noticeUntil = 0;
      a.say(`${green("✓")} ${file}\n${dim(`${Object.keys(bundle.files).length} file(s), ${bundle.memory.length} note(s). Continue anywhere: amness run --bundle <file> "continue"  or  /import <file>`)}`);
    } },
    { name: "import", help: "continue from a session bundle", args: "<file>", run: async (a, arg) => {
      if (!arg) return void a.say("usage: /import <bundle.json>", yellow);
      const b: Bundle = readBundle(resolve(a.cwd, arg));
      a.newConversation();
      await a.turn(`Continue the work from a previous session.\n\nOriginal task: ${b.task}\nStatus then: ${b.status.finished ? "finished" : "unfinished"}\n\n${b.handoff}\n\nRe-check the workspace before continuing.`);
    } },
    { name: "diff", help: "review every change from this session", live: true, run: async (a) => {
      if (!a.edits.length) return void a.say("no edits in this session yet", dim);
      a.openPager(a.edits.flatMap((e) => ["", bold(`${e.path}${e.created ? " (new)" : ""}  ${green("+" + e.added)} ${red("-" + e.removed)}`), ...renderDiff(e.diff, a.screen.cols - 1, 400)]), "changes");
    } },
    { name: "undo", help: "revert the last turn (files and conversation)", run: (a) => {
      if (!a.session.turns.length) return void a.say("nothing to undo", dim);
      a.rewindTo(a.session.turns.length - 1);
    } },
    { name: "rewind", help: "go back to an earlier turn", run: (a) => a.openRewind() },
    { name: "loop", alias: "trace", help: "step-by-step trace of the agent loop: model turns, tools, guards", live: true, run: (a) => {
      const T = a.trace; if (!T.length) return a.say(dim("no loop activity yet: send a task first"));
      const tot = T.reduce((n, s) => n + s.completion + s.prompt, 0), ms = T.reduce((n, s) => n + s.ms, 0);
      const waste = cacheWaste(a.tracer?.turns ?? []), wasteCost = waste ? estimateCost(a.cfg.model, waste, 0) : null, wasteNote = waste > 500 ? `${fmtTokens(waste)} tokens re-read at full price after cache breaks${wasteCost !== null ? ` (≈ ${fmtCost(wasteCost - estimateCost(a.cfg.model, waste, 0, waste)!)} wasted)` : ""} · ` : "";
      const rounds = roundOf(T.map((s) => ({ ...s })));
      const out = ["", bold(`Agent loop · ${T.length} turn${T.length === 1 ? "" : "s"} · ${rounds} round${rounds === 1 ? "" : "s"} · ${fmtDuration(ms)} · ${fmtTokens(tot)} tokens`), dim("◉ gather: read, search · ✎ act: edit, run · ✓ verify: test, build · guessed from the tool calls"), dim(`${wasteNote}${a.trimmed ? `trimmed ~${fmtTokens(Math.round(a.trimmed / 4))} tokens of stale or noisy output · ` : ""}${a.cacheBreaks ? `${a.cacheBreaks} cache break${a.cacheBreaks === 1 ? "" : "s"} · ` : ""}each turn: the model answers, its tool calls run, results go back; guards are shown where they fired`), ""];
      for (const s of T) {
        const pad = String(s.n).padStart(2);
        const st = stagesOf(s.tools);
        out.push(`${cyan(`${pad} ●`)} ${bold("model")}${st.length ? " " + cyan(st.map((x) => `${STAGE_GLYPH[x]} ${x}`).join(" + ")) : ""} ${dim(`${fmtDuration(s.ms)} · ${fmtTokens(s.prompt)} in · ${fmtTokens(s.completion)} out${s.cached ? ` · ${fmtTokens(s.cached)} cached` : ""}`)}`);
        s.tools.forEach((x, i) => out.push(`     ${dim(i === s.tools.length - 1 && !s.notes.length ? "└─" : "├─")} ${x.ok ? green("✓") : red("✗")} ${toolCall(x.name, x.args)} ${dim(fmtDuration(x.ms))}${s.parallel && s.parallel > 1 && i === 0 ? dim(`  (${s.parallel} calls this turn)`) : ""}`));
        s.notes.forEach((n, i) => out.push(`     ${dim(i === s.notes.length - 1 ? "└─" : "├─")} ${yellow("⚑")} ${dim(n)}`));
        if (!s.tools.length && !s.notes.length) out.push(`     ${dim("└─ replied without tools")}`);
      }
      return a.openPager(out, "loop trace");
    } },
    { name: "tokens", alias: "cost", help: "context window, what fills it, tokens and cost", live: true, run: (a) => {
      a.commit(tokenReport({ model: a.cfg.model, window: a.window, messages: a.session.messages, usage: a.session.usage, series: a.session.usage.series ?? [], lastPrompt: a.lastPrompt, turnTokens: a.runTokens, turnBudget: a.running ? a.cfg.maxTokens : 0, width: a.width,
        toolDefChars: JSON.stringify(a.agent.registry.visible({ step: 0, messages: [] }).map((t) => ({ name: t.name, description: t.description, parameters: t.schema }))).length }));
      // The last turn's spending per model, when more than one model worked on it (a local explorer, a cheaper reviewer).
      const bm = Object.entries(a.budget.byModel);
      if (bm.length > 1) a.commit(["", bold("  Last turn by model"), ...bm.map(([id, e]) => `  ${dim((e.tier ?? "?").padEnd(9))}${id.padEnd(32)} ${String(e.calls).padStart(3)} calls  ${fmtTokens(e.tokens).padStart(7)} tokens  ${(e.ms / 1000).toFixed(1).padStart(6)}s waiting`)]);
    } },
    { name: "todos", help: "show the agent's checklist, or change it: /todos edit", args: "[edit]", live: true, run: async (a, arg) => {
      if (arg.trim() === "edit") return void (await a.editTodos());
      a.commit(["", ...(a.todos.length ? todoList(a.todos, a.width) : [dim("  no todo list right now")]), ...(a.todos.length ? [dim("  /todos edit changes it")] : [])]);
    } },
    { name: "edit", help: "edit one of your earlier messages and send it again from there (the old version is kept as a branch)", args: "[n]", run: async (a, arg) => {
      if (a.running) return void a.say("wait for the current turn to finish", dim);
      if (!a.session.turns.length) return void a.say("nothing to edit yet", dim);
      const n = arg.trim() ? Number(arg) - 1 : await a.pick("Edit which message?", a.session.turns.map((t, i) => ({ label: `${i + 1}. ${t.text.replace(/\s+/g, " ").slice(0, 70)}`, value: i })).reverse());
      if (n === undefined || !Number.isInteger(n) || !a.session.turns[n]) return void (arg.trim() && a.say(`no message ${arg}`, red));
      if (a.remote) {                                                              // no input box to edit in: an editor dialog instead
        const text = await a.editLongText(`Edit message ${n + 1}`, a.session.turns[n].text, "Amness goes back to before this message (files too) and sends your new version. The old version is kept in /branches.");
        if (text !== undefined && text.trim()) await a.editMessage(n, text);
        return;
      }
      a.startEditing(n);
    } },
    { name: "harness", help: "the agent loop's settings: guards on or off, step limit, no-progress limit, context budget", args: "[on|off <guard> · steps <n> · stagnation <n> · budget <chars> · rewrites on|off · reset]", run: async (a, arg) => {
      const h = { ...(a.cfg.harness ?? {}) }, words = arg.trim().split(/\s+/).filter(Boolean), save = (msg: string) => { a.cfg.harness = h; a.saveConfig(); a.buildAgent(); a.say(msg, dim); };
      const offSet = new Set(h.off ?? []), num = (v: string | undefined, min: number) => { const n = Number(String(v ?? "").replace(/k$/i, "000")); return Number.isFinite(n) && n >= min ? Math.round(n) : undefined; };
      if (words[0] === "on" || words[0] === "off") {
        const g = GUARDS.find((x) => x.name === words[1]); if (!g) return void a.say(`unknown guard "${words[1] ?? ""}". Guards: ${GUARDS.map((x) => x.name).join(", ")}`, red);
        if (words[0] === "off") offSet.add(g.name); else offSet.delete(g.name); h.off = [...offSet]; if (!h.off.length) delete h.off;
        return void save(`${g.label} (${g.name}) ${words[0]}`);
      }
      if (words[0] === "steps" || words[0] === "stagnation" || words[0] === "budget") {
        const v = num(words[1], words[0] === "budget" ? 4000 : 1); if (v === undefined) return void a.say(`give a number, for example /harness ${words[0]} ${words[0] === "budget" ? "80000" : words[0] === "steps" ? "80" : "6"}`, red);
        if (words[0] === "steps") h.maxSteps = v; else if (words[0] === "stagnation") h.stagnationTurns = v; else h.contextBudget = v;
        return void save(`${words[0] === "steps" ? "step limit" : words[0] === "stagnation" ? "no-progress limit" : "context budget"} → ${v}`);
      }
      if (words[0] === "rewrites") { h.governRewrites = words[1] === "on" || undefined; return void save(`cost-aware rewrites ${h.governRewrites ? "on" : "off"}`); }
      if (words[0] === "reset") { a.cfg.harness = undefined; a.saveConfig(); a.buildAgent(); return void a.say("harness settings back to the defaults", dim); }
      if (words.length) return void a.say("usage: /harness [on|off <guard> · steps <n> · stagnation <n> · budget <chars> · rewrites on|off · reset]", red);
      for (;;) {                                                                    // no arguments: an interactive list, changed one item at a time
        const v = harnessView(a.cfg, a.profile.profile);
        const pick = await a.pick<string>("Harness   ● on   ○ off", [
          ...v.guards.map((g) => ({ label: `${g.on ? "●" : "○"} ${g.label}`, value: `g:${g.name}`, hint: g.byProfile ? "off in the model profile" : g.what })),
          { label: `Step limit: ${v.maxSteps}`, value: "n:steps", hint: "the most model turns in one run" },
          { label: `No-progress limit: ${v.stagnationTurns}`, value: "n:stagnation", hint: "turns without measurable progress before it stops" },
          { label: `Context budget: ${v.contextBudget.toLocaleString()} characters`, value: "n:budget", hint: "when old tool output starts to be shortened (when no context window is known)" },
          { label: `${v.governRewrites ? "●" : "○"} Cost-aware rewrites`, value: "rewrites", hint: "shorten old output only when it saves more than the lost cache costs (not measured to help)" },
          { label: "Reset to the defaults", value: "reset" },
        ]);
        if (!pick) return;
        if (pick.startsWith("g:")) { const name = pick.slice(2), cur = v.guards.find((g) => g.name === name)!; await a.runCommand(`/harness ${cur.on ? "off" : "on"} ${name}`); continue; }
        if (pick === "rewrites") { await a.runCommand(`/harness rewrites ${v.governRewrites ? "off" : "on"}`); continue; }
        if (pick === "reset") { await a.runCommand("/harness reset"); continue; }
        const key = pick.slice(2), now = key === "steps" ? v.maxSteps : key === "stagnation" ? v.stagnationTurns : v.contextBudget;
        const typed = await a.askText(key === "steps" ? "Step limit" : key === "stagnation" ? "No-progress limit (turns)" : "Context budget (characters)", { initial: String(now) });
        if (typed) await a.runCommand(`/harness ${key} ${typed}`);
      }
    } },
    { name: "copy", help: "copy the last reply to the clipboard (or: code, all)", args: "[code|all]", live: true, run: (a, arg) => {
      const bs = a.blocks.blocks, last = [...bs].reverse().find((b) => b.kind === "assistant" || b.kind === "summary");
      let text = "";
      if (arg === "all") text = bs.flatMap((b) => b.kind === "user" ? ["> " + b.text, ""] : b.kind === "assistant" || b.kind === "summary" ? [b.text, ""] : b.kind === "tool" ? [`[${b.name} ${b.args.slice(0, 120)}]`] : []).join("\n").trim();
      else if (arg === "code") { const cb = last && "text" in last ? codeBlocks(last.text) : []; text = cb[cb.length - 1] ?? ""; if (!text) return void a.say("no code block in the last reply", dim); }
      else text = last && "text" in last ? last.text : "";
      if (!text) return void a.say("nothing to copy yet", dim);
      a.copyText(text); a.say(`copied ${text.length} characters to the clipboard`, dim);
    } },
    { name: "vim", help: "vim-style editing in the input box (Esc for normal mode: hjkl w b e 0 $ x dd dw cw yy p u, i/a/o to type)", args: "[on|off]", run: (a, arg) => {
      const on = arg === "on" ? true : arg === "off" ? false : !a.cfg.vim;
      a.cfg.vim = on || undefined; a.vim.mode = "insert"; a.saveConfig(); a.say(`vim mode ${on ? "on: Esc switches to normal mode" : "off"}`, dim);
    } },
    { name: "notify", help: "desktop notification when a long turn ends or approval is needed while you are in another window", args: "[on|off|test]", run: (a, arg) => {
      if (arg === "test") { a.notifier("Amness", "notifications work"); return void a.say("sent a test notification", dim); }
      if (arg === "on" || arg === "off") { a.cfg.notify = arg; a.saveConfig(); return void a.say(`notifications ${arg}`, dim); }
      a.say(`notifications are ${a.cfg.notify === "off" ? "off" : "on"}${a.focused === undefined ? " (this terminal has not reported focus yet, so none are sent)" : ""}. /notify on|off|test`, dim);
    } },
    { name: "keepwarm", help: "keep the Claude prompt cache alive while you are away (costs a few cache reads)", args: "[on|off]", run: (a, arg) => {
      if (!arg) return void a.say(`keep-warm is ${a.cfg.keepWarm ? "on" : "off"}. Claude drops its prompt cache after 5 idle minutes; with this on, a tiny re-send every ~4.5 minutes (at most 3 per break) keeps it. Only affects Claude.`, dim);
      a.cfg.keepWarm = arg === "on"; a.saveConfig(); if (!a.cfg.keepWarm) a.stopWarm(); a.say(`keep-warm ${a.cfg.keepWarm ? "on" : "off"}${a.cfg.keepWarm && a.cfg.provider !== "anthropic" ? dim("  (only Claude needs it; OpenAI requests already ask for 24h cache retention)") : ""}`, dim);
    } },
    { name: "procs", help: "background processes the agent started (stop one with /procs stop <id>)", args: "[stop <id>]", live: true, run: async (a, arg) => {
      const [sub, id] = arg.split(/\s+/);
      if (sub === "stop" && id) { try { const p = await a.agent.procs!.stop(id); return void a.say(`stopped ${p.id} (${p.name})`, dim); } catch (e) { return void a.say((e as Error).message, red); } }
      const l = a.agent.procs?.list() ?? [];
      a.commit(["", bold("  Background processes"), ...(l.length ? l.map((p) => `  ${(p.status === "running" ? green : dim)(p.id.padEnd(4))} ${p.name.padEnd(28)} ${dim(`${p.status}${p.status === "exited" ? ` (${p.code})` : ""} · pid ${p.pid ?? "?"} · ${Math.round((Date.now() - p.startedAt) / 1000)}s`)}`) : [dim("  none")])]);
    } },
    { name: "hooks", help: "lifecycle hooks in effect (.amness/hooks.json, ~/.amness/hooks.json)", live: true, run: (a) => {
      const l = a.hooks.list(), fp = Hooks.fingerprint(a.cwd);
      a.commit(["", bold("  Hooks"), ...(l.length ? l.map((h) => `  ${cyan(h.event.padEnd(16))} ${h.def.match ? dim(`[${h.def.match}] `) : ""}${h.def.command} ${dim(`${h.def.timeout ?? 10}s${h.def.failClosed ? " · fail closed" : ""}`)}`) : [dim("  none active")]), ...(fp && !l.some(() => true) ? [dim("  this project has .amness/hooks.json but it is not approved; restart and allow it")] : []), dim("  exit 0 allows · exit 2 blocks (stderr is shown to the model) · stdout JSON can add context or rewrite arguments")]);
    } },
    { name: "trust", args: "[reset]", help: "this folder's trust: shows it and asks again about project hooks, rules and plugins you said no to; reset forgets the yes answers too", run: async (a, arg) => {
      if (!a.persist) return void a.say("nothing is saved in this session, so there is nothing to change", dim);
      const st = loadState(), cwd = a.cwd, hfp = projectConfigFingerprint(cwd), pfp = pluginFingerprint(cwd), reset = arg.trim() === "reset";
      const what = (fp: string | undefined, yes?: Record<string, string>, no?: Record<string, string>) => !fp ? dim("none in this project") : yes?.[cwd] === fp ? green("trusted") : no?.[cwd] === fp ? yellow("you said no") : dim("not asked yet");
      a.commit(["", bold("  Trust for this folder"), `  folder          ${isTrustedDir(st, cwd) ? green("trusted") : yellow("not trusted")}`, `  hooks and rules ${what(hfp, st.hookTrust, st.hookDeclined)}`, `  plugins         ${what(pfp, st.pluginTrust, st.pluginDeclined)}`, dim("  remove a trusted folder in Preferences (Trusted folders)")]);
      for (const k of ["hookDeclined", "pluginDeclined", ...(reset ? ["hookTrust", "pluginTrust"] as const : [])] as const) { const m = st[k]; if (m) delete m[cwd]; }
      saveState(st);
      if ((hfp && st.hookTrust?.[cwd] !== hfp) || (pfp && st.pluginTrust?.[cwd] !== pfp)) await a.askHookTrust();
      else if (reset) { a.loadHooks(); await a.loadPluginsNow(); a.buildAgent(); }
    } },
    { name: "permissions", help: "permission rules: list · allow|ask|deny <rule> · e.g. /permissions allow sh(npm test*)", args: "[allow|ask|deny <rule>]", live: true, run: (a, arg) => {
      const [list, ...rest] = arg.split(/\s+/), rule = rest.join(" ");
      if (list === "allow" || list === "ask" || list === "deny") {
        if (!rule) return void a.say(`usage: /permissions ${list} sh(npm test*)  ·  edit(src/**)  ·  read`, dim);
        try { Permissions.addProjectRule(a.cwd, list, rule); } catch (e) { return void a.say((e as Error).message, red); }
        const fp = projectConfigFingerprint(a.cwd), st = loadState(); if (fp && st.hookTrust?.[a.cwd]) { st.hookTrust[a.cwd] = fp; saveState(st); }     // you wrote it, so it stays trusted
        a.loadHooks(); a.buildAgent(); return void a.say(`${list} ${rule} saved to .amness/permissions.json`, dim);
      }
      const r = a.rules.rules();
      a.commit(["", bold("  Permission rules"), ...(["deny", "ask", "allow"] as const).flatMap((k) => r[k].map((x) => `  ${(k === "deny" ? red : k === "ask" ? yellow : green)(k.padEnd(6))} ${x}`)), ...(!r.deny.length && !r.ask.length && !r.allow.length ? [dim("  no rules yet")] : []),
        "", dim("  always on, in every mode including yolo: no recursive delete of / or ~, no force-push to main, no editing .git or these rule files; curl|sh and force-pushes always ask"), dim("  precedence: that floor > deny > ask > allow > permission mode")]);
    } },
    { name: "budget", help: "show or set the token cap per turn (cached input counts a tenth)", args: "[tokens, e.g. 500k]", run: (a, arg) => {
      const b = a.budget, used = Math.round(b.effective);
      if (!arg) return void a.say(`cap per turn: ${a.cfg.maxTokens.toLocaleString()} tokens (cached input counts a tenth). Last/current turn used ${used.toLocaleString()}. Set it with /budget 500k. At 50%, 75% and 90% the model is told to wrap up, and just before the cap it writes a final report.`, dim);
      const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(arg.trim()); if (!m) return void a.say("give a number such as 400000, 400k or 1m", dim);
      const n = Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1)); if (n < 10_000) return void a.say("the cap must be at least 10000 tokens", dim);
      a.cfg.maxTokens = n; b.maxTokens = n; a.saveConfig(); a.say(`cap per turn is now ${n.toLocaleString()} tokens`, dim);
    } },
    { name: "reload-plugins", help: "load the plugin files again (after you edited one)", run: async (a) => {
      await a.askPluginTrust(); a.buildAgent(); a.say(`${a.plugins.length} plugin${a.plugins.length === 1 ? "" : "s"} loaded${a.plugins.length ? ": " + a.plugins.map((p) => p.name).join(", ") : ""}. Project plugins you did not approve are skipped (if you edited one, Amness asks you to approve the new version first).`, dim);
    } },
    { name: "shell", help: "which shell runs the agent's commands (bash, zsh, sh, pwsh, powershell, cmd, or auto)", args: "[name|auto]", run: (a, arg) => {
      const cur = currentShell(), found = SHELL_CHOICES.filter((n) => n !== "auto").filter((n) => { const s = chooseShell(n).shell; return !chooseShell(n).fallback && s.name === n; });
      if (!arg) return void a.say(`shell: ${cur.name} (${cur.file}). Setting: ${a.cfg.shell ?? "auto"}. Installed here: ${found.join(", ") || "none found"}. The model is told which shell it has. Change with /shell <name> or /shell auto.`, dim);
      if (!SHELL_CHOICES.includes(arg)) return void a.say(`unknown shell "${arg}". Choose one of ${SHELL_CHOICES.join(", ")}`, dim);
      a.cfg.shell = arg === "auto" ? undefined : arg; setShell(a.cfg.shell); a.saveConfig(); a.buildAgent();
      const now = currentShell(), fb = shellFallbackNote(); a.say(`shell: ${now.name} (${now.file})${fb ? ". " + fb : ""}. New conversations tell the model about it.`, dim);
    } },
    { name: "prompt", help: "choose the system prompt from .amness/prompts (or off for the built-in one)", args: "[id|list|off]", run: (a, arg) => {
      const list = loadPrompts(a.cwd);
      if (!arg || arg === "list") return void a.say(`prompt: ${a.cfg.prompt ?? "built-in"}. ${list.length ? "Available: " + list.map((p) => p.id).join(", ") + ". Use /prompt <id>, or /prompt off." : "None saved yet: put a Markdown file at .amness/prompts/<id>.md (its text replaces the system prompt)."} Compare them with: amness eval --variants full,prompt:<id>`, dim);
      if (arg === "off") { a.cfg.prompt = undefined; a.saveConfig(); a.buildAgent(); return void a.say("prompt: built-in", dim); }
      if (!list.some((p) => p.id === arg)) return void a.say(`no prompt "${arg}". Available: ${list.map((p) => p.id).join(", ") || "none"}`, dim);
      a.cfg.prompt = arg; a.saveConfig(); a.buildAgent(); a.say(`prompt ${arg} on: it replaces the whole system prompt for new conversations`, dim);
    } },
    { name: "strategy", help: "loop strategy: plan-first, explore-then-act, or off", args: "[name|off]", run: (a, arg) => {
      const names = Object.keys(STRATEGIES);
      if (!arg) return void a.say(`strategy: ${a.cfg.strategy ?? "none (default loop)"}. Choose one of ${names.join(", ")}, or off. plan-first writes a plan before any tool call; explore-then-act allows only reading for the first steps. Measure them with: amness eval --variants full,strategy:plan-first`, dim);
      if (arg === "off") { a.cfg.strategy = undefined; a.saveConfig(); a.buildAgent(); return void a.say("strategy off", dim); }
      if (!names.includes(arg)) return void a.say(`unknown strategy "${arg}". Choose one of ${names.join(", ")}, or off`, dim);
      a.cfg.strategy = arg; a.saveConfig(); a.buildAgent(); a.say(`strategy ${arg} on`, dim);
    } },
    { name: "plugins", help: "plugins loaded (code in .amness/plugins that extends the loop, tools, guards and evals)", run: (a) => {
      if (!a.plugins.length) return void a.say("no plugins loaded. Put a file in .amness/plugins/ (or ~/.amness/plugins/) that exports definePlugin({ name, ... }); see docs/plugins.md. Project plugins ask for your approval first.", dim);
      a.commit(["", bold("  Plugins"), ...a.plugins.map((p) => `  ${cyan(p.name.padEnd(22))} ${dim([p.tools?.length ? `${p.tools.length} tool(s)` : "", p.hooks ? `hooks: ${Object.keys(p.hooks).join(", ")}` : "", p.system ? "system prompt" : "", p.cases?.length ? `${p.cases.length} eval case(s)` : "", p.variants ? `variants: ${Object.keys(p.variants).join(", ")}` : ""].filter(Boolean).join(" · "))} ${p.description ?? ""}`)]);
    } },
    { name: "plans", help: "offer the plan of a similar finished task as a starting point (off until measured)", args: "[on|off]", run: (a, arg) => {
      if (arg !== "on" && arg !== "off") { const s = a.agent.plans?.stats(); return void a.say(`plan cache is ${a.cfg.plans ? "on" : "off"}${s ? `: ${s.plans} stored, offered ${s.offered}×, led to a finished task ${s.helped}×` : ""}. /plans on: a finished task leaves a short plan (files changed, checks run, result); a similar new task is offered it as a starting point.`, dim); }
      a.cfg.plans = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`plan cache ${arg}`, dim);
    } },
    { name: "cache", help: "what the harness reused instead of repeating: reads, plans, and the server's prefix cache", run: async (a) => {
      const t = a.agent.toolCache.stats(), s = a.agent.plans?.stats(), lines = [`tool results: ${t.hits} reused of ${t.hits + t.misses} pure reads; ${t.pointers} answered with a one-line pointer, about ${Math.round(t.saved / 3.5).toLocaleString()} tokens not sent again`];
      lines.push(s ? `plans: ${s.plans} stored, offered ${s.offered}×, led to a finished task ${s.helped}×` : "plans: off (/plans on)");
      const px = await prefixCacheRate(a.cfg.baseUrl); if (px !== undefined) lines.push(`server prefix cache: ${Math.round(px * 100)}% of prompt tokens were served from the server's cache`);
      lines.push("replies on disk: amness eval --cache / amness run --cache (reruns cost nothing)");
      a.commit(["", bold("  Cache"), ...lines.map((l) => "  " + dim(l))]);
    } },
    { name: "lsp", help: "append language-server errors to edit results (needs typescript-language-server, pyright, gopls or rust-analyzer)", args: "[on|off]", run: (a, arg) => {
      if (arg !== "on" && arg !== "off") return void a.say(`language-server diagnostics are ${a.cfg.lsp ? "on" : "off"}. /lsp on: each edit result also lists the errors an installed language server reports for that file.`, dim);
      a.cfg.lsp = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`language-server diagnostics ${arg}`, dim);
    } },
    { name: "approver", help: "a second model pre-approves clearly safe risky calls (never the safety floor)", args: "[on|off]", run: (a, arg) => {
      if (arg !== "on" && arg !== "off") return void a.say(`approval reviewer is ${a.cfg.approvalReviewer ? "on" : "off"}. /approver on: a model reads each risky call before you are asked and may approve it with a stated reason; floor and untrusted-text calls always ask you. One short model call per risky action.`, dim);
      a.cfg.approvalReviewer = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`approval reviewer ${arg}`, dim);
    } },
    { name: "reviewer", help: "independent skeptical reviewer: criteria before the work, a check before it is accepted (costs extra model calls)", args: "[on|off]", run: (a, arg) => {
      if (!arg) return void a.say(`reviewer is ${a.cfg.review ? "on" : "off"}. /reviewer on: a fresh, read-only reviewer writes acceptance criteria before a task and checks the work against them before it can finish (at most two rounds). Roughly +2 to +4 model calls per task.`, dim);
      a.cfg.review = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`reviewer ${arg === "on" ? "on" : "off"}`, dim);
    } },
    { name: "review", help: "a read-only review of your changes (vs the base branch, or /review <base>)", args: "[base]", run: async (a, arg) => {
      let r; try { r = await diffForReview(a.cwd, arg || undefined); } catch (e) { return void a.say(`not a git repository, or git failed: ${(e as Error).message}`, red); }
      if (!r.diff.trim()) return void a.say(`no changes against ${r.against} to review`, dim);
      a.say(`reviewing ${r.diff.split("\n").filter((l) => l.startsWith("diff --git")).length} changed file(s) against ${r.against}…`, dim);
      const v = await reviewWork({ model: a.roles.review ?? a.model, cwd: a.cwd, task: "Review these changes as a careful colleague would before they are merged.", contract: ["the change does what its code and commit messages suggest, without introducing bugs", "edge cases and error paths are handled", "nothing unrelated or leftover (debug code, secrets, commented-out code) is included", "behaviour that changed is covered by tests, or the missing tests are named"], summary: "(a human asked for a review; there is no author summary)", diffs: r.diff.slice(0, 60_000), commands: "", verify: a.verify, budget: a.budget });
      a.commit(["", v.inconclusive ? `  ${yellow("?")} ${dim("the reviewer gave no usable verdict; try again, or use /reviewer on for tasks")}` : v.pass ? `  ${green("✔")} ${bold("review: no problems found")}` : `  ${yellow("✖")} ${bold(`review: ${v.findings.length} finding${v.findings.length === 1 ? "" : "s"}`)}`, ...v.findings.map((f) => `    ${yellow("•")} ${f}`)]);
    } },
    { name: "pr", help: "draft a pull request from your branch and create it with gh after you confirm (/pr draft for a draft PR)", args: "[draft]", run: async (a, arg) => {
      const have = await new Promise<boolean>((res) => execFile("gh", ["--version"], (e) => res(!e)));
      if (!have) return void a.say("the GitHub CLI (gh) is needed to create pull requests: https://cli.github.com", yellow);
      const branch = await currentBranch(a.cwd), base = await defaultBase(a.cwd);
      if (!base) return void a.say("could not find a base branch (no origin/HEAD, main or master)", red);
      if (branch === base.replace(/^origin\//, "") || branch === "HEAD") return void a.say(`you are on ${branch}; make a branch for your changes first`, yellow);
      const { diff } = await diffForReview(a.cwd, base), log = await commitLog(a.cwd, base);
      if (!diff.trim() && !log) return void a.say(`nothing to open a pull request for against ${base}`, dim);
      a.say("drafting the pull request…", dim);
      let d; try { d = await draftPr(a.roles.compact ?? a.model, { diff, log, branch }); } catch (e) { return void a.say((e as Error).message, red); }
      a.commit(["", bold(`  ${d.title}`), dim(`  ${branch} → ${base.replace(/^origin\//, "")}`), "", ...d.body.split("\n").map((l) => "  " + l)]);
      const choice = await a.pick("Create this pull request on GitHub?", [{ label: "Create it", value: "pr" }, { label: "Create it as a draft", value: "draft" }, { label: "Cancel", value: "no" }]);
      if (!choice || choice === "no") return void a.say("not created", dim);
      if (!(await hasUpstream(a.cwd))) { const push = await a.pick("The branch is not on the remote yet. Push it now (git push -u origin HEAD)?", [{ label: "Yes, push it", value: "y" }, { label: "No", value: "n" }]); if (push !== "y") return void a.say("not created: push the branch first", dim); try { await pushBranch(a.cwd); } catch (e) { return void a.say(`push failed: ${(e as Error).message}`, red); } }
      try { const url = await createPr(a.cwd, d, { base, draft: choice === "draft" || arg === "draft" }); a.say(`created: ${url}`, green); } catch (e) { a.say(`gh failed: ${(e as Error).message}`, red); }
    } },
    { name: "report", help: "recurring problems in your session traces · /report case <name> turns the last request into an eval task", args: "[case <name>]", run: async (a, arg) => {
      const [sub, name] = arg.split(/\s+/);
      if (sub === "case") {
        if (!name) return void a.say("usage: /report case <name>   (then it asks for the command that proves the task is solved)", dim);
        const prompts = a.blocks.prompts(), last = prompts.at(-1)?.block; if (!last || last.kind !== "user") return void a.say("send a task first: the case is built from your last request", dim);
        const check = await a.askText(`A command that exits 0 only when "${last.text.slice(0, 50).replace(/\s+/g, " ")}" is really done (the agent never sees it)`); if (!check) return void a.say("cancelled", dim);
        const r = caseFromWorkspace(a.cwd, { name, task: last.text, check, verify: a.verify }); return void a.say(`wrote ${r.path.replace(a.cwd + "/", "")} (${r.files} files from git HEAD). Run: amness eval --cases .amness/evals/cases --variants ab`, dim);
      }
      a.commit(["", ...formatMining(join(a.cwd, ".amness", "traces")).split("\n").map((l) => "  " + l)]);
    } },
    { name: "models", help: "use other models for some jobs: /models <role> <model|off>; a model is an id, provider:model or server:<name>[/model]", args: "[role model]", run: (a, arg) => {
      const [role, id] = arg.split(/\s+/), roles: readonly string[] = ROLE_NAMES;
      if (!role) { const m = a.cfg.models ?? {}, lab = a.wired?.labels ?? {}; return void a.commit(["", bold("  Models"), `  ${dim("main".padEnd(11))} ${a.cfg.server ? `server:${a.cfg.server}/` : `${a.cfg.provider}:`}${a.cfg.model}`, ...roles.map((r) => `  ${dim(r.padEnd(11))} ${(lab as Record<string, string | undefined>)[r] ?? ((m as Record<string, string | undefined>)[r] ? `${(m as Record<string, string>)[r]} ${dim("(same as main)")}` : dim("(main model)"))}`), `  ${dim("fallback".padEnd(11))} ${lab.fallback ?? a.cfg.fallback ?? dim("(none)")}`, dim("  e.g. /models explore server:lab   /models compact anthropic:claude-haiku-5-5   /models review off")]); }
      if (role !== "fallback" && !roles.includes(role)) return void a.say(`usage: /models ${roles.join("|")}|fallback <model | off>`, red);
      if (!id) return void a.say(`usage: /models ${role} <model | off>`, red);
      let label = id; if (id !== "off") { try { label = resolveConfig(id, a.cfg).label; } catch (e) { return void a.say((e as Error).message, red); } }
      if (role === "fallback") a.cfg.fallback = id === "off" ? undefined : id; else a.cfg.models = { ...(a.cfg.models ?? {}), [role]: id === "off" ? undefined : id };
      a.saveConfig(); a.buildAgent(); a.say(`${role} → ${id === "off" ? "main model" : label}`, dim);
      if (id !== "off" && role !== "fallback") {
        // A model that `amness doctor` checked carries its verdict in its profile: say so when it did not qualify for this job.
        const need = role === "cheap" ? "explore" : role === "advisor" ? "compact" : role, rid = resolveConfig(id, a.cfg).name;
        let q: { roles: string[] } | undefined; try { q = loadProfile(a.cwd, rid).profile.qualified; } catch { /* a broken profile is reported elsewhere */ }
        if (q && !q.roles.includes(need)) a.say(`  note: amness doctor did not qualify ${label} for ${need} (it qualified for: ${q.roles.join(", ") || "nothing"})`, yellow);
        else if (!q) a.say(`  tip: /doctor ${id} checks how this model uses tools`, dim);
      }
    } },
    { name: "bg", alias: "background", help: "run a task in the background, in its own worktree: /bg <task> · /bg (list) · /bg show|apply|drop|stop <n>", args: "[task | show|apply|drop|stop n]", live: true, run: async (a, arg) => {
      const [sub, n] = arg.trim().split(/\s+/), id = Number(n);
      if (!arg.trim()) {
        if (!a.bg.tasks.length) return void a.say("no background tasks. Start one with /bg <task>: it runs in its own git worktree while you keep working here", dim);
        return void a.commit(["", bold("  Background tasks"), ...a.bg.tasks.map((t) => "  " + bgLine(t)), dim("  /bg show <n> · /bg apply <n> (take its changes) · /bg drop <n> · /bg stop <n>")]);
      }
      if (["show", "apply", "drop", "stop"].includes(sub) && Number.isInteger(id) && n !== undefined) {
        if (sub === "stop") return void a.say(a.bg.stop(id), dim);
        if (sub === "drop") return void a.say(await a.bg.drop(id), dim);
        if (sub === "apply") { const msg = await a.bg.apply(id); a.say(msg, /^applied/.test(msg) ? green : yellow); return; }
        const t = a.bg.get(id); if (!t) return void a.say(`no background task ${id}`, red);
        return void a.commit(["", bold(`  Background task ${t.id}`), `  ${dim("task".padEnd(8))} ${t.task}`, `  ${dim("status".padEnd(8))} ${t.status}`, `  ${dim("branch".padEnd(8))} ${t.branch}  ${dim(t.dir)}`,
          `  ${dim("changed".padEnd(8))} ${t.changed?.join(", ") || (t.status === "running" ? "(running)" : "nothing")}`, "", ...(t.summary ?? "(no summary yet)").split("\n").map((l) => "  " + l)]);
      }
      try { const t = await a.bg.start(arg.trim()); a.say(`started background task ${t.id} in ${t.branch}; keep working, you will be told when it ends (/bg lists them)`, green); }
      catch (e) { a.say((e as Error).message, red); }
    } },
    { name: "doctor", help: "check how a model uses tools and which jobs it can take: /doctor [model] [write]", args: "[model] [write]", run: async (a, arg) => {
      const words = arg.split(/\s+/).filter(Boolean), write = words.includes("write"), ref = words.find((w) => w !== "write") ?? a.cfg.model;
      let r; try { r = resolveConfig(ref, a.cfg); } catch (e) { return void a.say((e as Error).message, red); }
      const m = a.wired?.byRef(ref) ?? a.model;
      a.say(`checking ${r.label}: about ten short requests…`, dim);
      let rep; try { rep = await runDoctor(m, { stated: a.window }); } catch (e) { return void a.say(`doctor failed: ${(e as Error).message}`, red); }
      a.commit(["", ...formatDoctor(r.label, rep).split("\n").map((l) => "  " + l)]);
      if (write) { const at = new Date().toISOString().slice(0, 10); writeProfile(join(a.cwd, ".amness", "profile.json"), r.name, { ...rep.suggest, qualified: { roles: rep.qualified, at, by: "amness doctor" } }, `checked with amness doctor on ${at}`); a.say(`  saved in .amness/profile.json (${r.name})`, dim); a.buildAgent(); }
      else a.say("  /doctor " + ref + " write saves this in .amness/profile.json", dim);
    } },
    { name: "policy", help: "why recent actions were allowed, asked about or refused (rules, the safety floor, untrusted-text checks)", live: true, run: (a) => {
      a.commit(["", bold("  Recent policy decisions"), ...(a.policyLog.length ? a.policyLog.map((l) => "  " + (l.startsWith("deny") ? red(l.slice(0, 5)) : l.startsWith("ask") ? yellow(l.slice(0, 5)) : green(l.slice(0, 5))) + l.slice(5)) : [dim("  none yet: every call so far went through the permission mode alone")]),
        "", dim("  layers: safety floor > deny rules > untrusted-text check (commands copied from web pages or tool servers) > ask rules > allow rules > permission mode"), dim("  /permissions lists your rules, /sandbox shows OS enforcement")]);
    } },
    { name: "profile", help: "harness settings for this model (.amness/profile.json): guards switched off, limits", live: true, run: (a) => {
      const p = a.profile.profile;
      a.commit(["", bold("  Harness profile"), `  ${dim("model")}   ${a.cfg.model}`, `  ${dim("from")}    ${a.profile.sources.length ? a.profile.sources.map((s) => s.replace(a.cwd + "/", "")).join(", ") : dim("(none: built-in defaults)")}`, `  ${dim("off")}     ${p.off?.length ? p.off.join(", ") : dim("nothing: every guard is on")}`, `  ${dim("limits")}  ${[p.maxSteps !== undefined && `max steps ${p.maxSteps}`, p.stagnationTurns !== undefined && `stagnation after ${p.stagnationTurns} turns`].filter(Boolean).join(" · ") || dim("defaults")}`, ...(p.note ? [`  ${dim("note")}    ${p.note}`] : []), dim("  write one from measurements: amness eval --variants ablate --profile-out profile.json")]);
    } },
    { name: "router", help: "route exploration steps to a cheaper model when that pays off, cache cost included (needs /models cheap <id>)", args: "[on|off]", run: (a, arg) => {
      if (!arg) return void a.say(`router is ${a.cfg.router ? "on" : "off"}${a.cfg.models?.cheap ? ` (cheap model: ${a.cfg.models.cheap})` : dim("  (set one with /models cheap <model id>)")}. Planning, edits, failures and answers always use ${a.cfg.model}; a run of read-only steps moves to the cheap model once the saving repays the cold read of the conversation on that model's own cache.`, dim);
      if (arg === "on" && !a.cfg.models?.cheap) return void a.say("choose the cheap model first: /models cheap <model id>", red);
      a.cfg.router = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`router ${arg === "on" ? "on" : "off"}`, dim);
    } },
    { name: "sandbox", help: "OS sandbox for shell commands: off · workspace · strict (no network)", args: "[off|workspace|strict]", run: (a, arg) => {
      const kind = sandboxKind();
      if (!arg) return void a.say(`sandbox: ${a.cfg.sandbox ?? "off"}${kind ? dim(` (${kind === "seatbelt" ? "macOS Seatbelt" : "Bubblewrap"} available)`) : dim(` (not available here: ${sandboxHelp()})`)}.  workspace: commands can write only in the project and temp/cache folders, .git stays read-only. strict: also no network.`, dim);
      if (!SANDBOX_MODES.includes(arg as SandboxMode)) return void a.say("usage: /sandbox off | workspace | strict", red);
      if (arg !== "off" && !kind) return void a.say(`cannot turn the sandbox on: ${sandboxHelp()}`, red);
      a.cfg.sandbox = arg as SandboxMode; a.saveConfig(); a.say(`sandbox ${arg}${arg === "strict" ? dim("  (commands that need the network, like npm install, will fail)") : ""}`, dim);
    } },
    { name: "agents", help: "custom subagents (.amness/agents/*.md, .claude/agents/*.md) available to the task tool", live: true, run: (a) => {
      const l = a.agent.agents ?? [], w = a.agent.agentWarnings ?? [];
      a.commit(["", bold("  Subagents"), `  ${cyan("explore".padEnd(16))} ${dim("[built in · read-only]")} broad searches and questions that need reading many files`, ...l.map((s) => `  ${cyan(s.name.padEnd(16))} ${dim(`[${s.scope} · ${s.tools.join(", ")}${s.isolation ? " · isolated worktree" : ""}${s.model ? " · model " + s.model : ""}]`)} ${s.description}`), ...(!l.length ? [dim("  add .amness/agents/<name>.md (front matter: name, description, tools, model, isolation) to define your own")] : []), ...w.map((x) => "  " + yellow("⚠ ") + dim(x))]);
    } },
    { name: "skills", help: "see which skills exist and are in use; new, add, remove, on, off, show, draft", args: "[list|show|new|add|remove|on|off|draft|drafts|approve|reject] [name]", live: true, run: async (a, arg) => {
      const [sub = "list", ...rest] = arg.trim().split(/\s+/).filter(Boolean), name = rest[0], agent = a.agent, st = agent.skillState;
      const find = (n?: string) => (agent.allSkills ?? []).find((s) => s.name === n);
      const done = (msg: string) => { agent.rescanSkills(); a.say(msg, dim); };
      try {
        if (sub === "list" || sub === "ls") {
          const all = agent.allSkills ?? [], drafts = listDrafts(a.cwd);
          const row = (s: (typeof all)[number]) => { const off = st.isOff(s.name), uses = a.skillsUsed.get(s.name) ?? 0, k = st.stats[s.name]; const mark = off ? dim("⊘") : uses ? green("●") : dim("○"); const use = uses ? green(` in use ×${uses}`) : ""; const hist = k?.loaded ? dim(` · used ${k.loaded}×${k.finished || k.failed ? `, runs: ${k.finished} finished, ${k.failed} stopped` : ""}`) : ""; return `  ${mark} ${(off ? dim : cyan)(s.name.padEnd(22))} ${dim(`[${s.scope} · ${s.source}]`)}${use}${hist}${off ? dim(" · off") : ""}\n      ${dim(s.description)}`; };
          a.commit(["", bold("  Skills"), ...(all.length ? all.flatMap((s) => row(s).split("\n")) : [dim("  none yet. /skills new <name> makes one, /skills add <folder or git URL> installs one.")]), ...(drafts.length ? ["", bold("  Drafts waiting for you"), ...drafts.map((d) => `  ${cyan(d.name.padEnd(22))} ${dim(d.description)}`), dim("  /skills approve <name> · /skills reject <name>")] : []), ...((agent.skillWarnings ?? []).map((w) => "  " + dim(w))), "", dim("  ● in use now   ○ available   ⊘ switched off   ·   /skills show|new|add|remove|on|off|draft")]);
          return;
        }
        if (sub === "show") { const s = find(name); if (!s) return void a.say(name ? `no skill named ${name}` : "usage: /skills show <name>", red); const t = readFileSync(s.file, "utf8").split("\n"); a.commit(["", bold(`  ${s.name}`) + dim(`  ${s.dir}`), ...t.slice(0, 40).map((l) => "  " + dim(l)), ...(t.length > 40 ? [dim(`  … ${t.length - 40} more lines`)] : [])]); return; }
        if (sub === "on" || sub === "off") { const s = find(name); if (!s) return void a.say(name ? `no skill named ${name}` : `usage: /skills ${sub} <name>`, red); st.setOff(s.name, sub === "off"); return void done(`${s.name} is ${sub === "off" ? "switched off: not listed to the model and not loadable" : "on again"}`); }
        if (sub === "new") { const r = scaffoldSkill(a.cwd, name ?? "", rest.slice(1).join(" ") || undefined); return void done(`created ${r.file}\nedit it: the description line decides when the model loads it. It is picked up automatically.`); }
        if (sub === "remove" || sub === "rm") {
          const s = find(name); if (!s) return void a.say(name ? `no skill named ${name}` : "usage: /skills remove <name>", red);
          const ok = await a.pick(`Remove skill ${s.name}?`, [{ label: "Move to .amness/skills-trash", value: "yes", hint: "reversible: the folder is kept" }, { label: "Cancel", value: "no" }], 1); if (ok !== "yes") return;
          const to = trashSkill(a.cwd, s); st.forget(s.name); return void done(`removed ${s.name} (kept at ${to})`);
        }
        if (sub === "add" || sub === "install") {
          if (!name) return void a.say("usage: /skills add <folder or git URL> [user]   (user = install for all your projects)", red);
          a.say(`reading ${name}…`, dim); const src = fetchSource(name);
          try {
            const found = inspectSource(src.dir); if (!found.length) return void a.say(`no SKILL.md found in ${name} (or one folder down)`, red);
            const scope = rest[1] === "user" ? "user" : "project";
            a.commit(["", bold(`  Skills found in ${name}`), ...found.flatMap((f) => [`  ${f.problems.length ? red("✗") : green("✓")} ${cyan(f.name)} ${dim(`${f.files.length} file${f.files.length === 1 ? "" : "s"}`)}${f.scripts.length ? yellow(`  includes scripts: ${f.scripts.slice(0, 4).join(", ")}`) : ""}`, `      ${dim(f.description || "(no description)")}`, ...f.problems.map((p) => "      " + red(p))]), "", dim("  A skill is a set of instructions the model will follow. Read it first (/skills show <name> after installing), and do not install skills you do not trust.")]);
            const ok = await a.pick(`Install ${found.filter((f) => !f.problems.length).length} skill(s) for ${scope === "user" ? "all your projects" : "this project"}?`, [{ label: "Install", value: "yes" }, { label: "Cancel", value: "no" }], 1); if (ok !== "yes") return;
            const r = installSkills(a.cwd, found, { scope }); return void done(`${r.installed.length ? `installed: ${r.installed.join(", ")}` : "nothing installed"}${r.skipped.length ? `\nskipped: ${r.skipped.join("; ")}` : ""}`);
          } finally { src.cleanup(); }
        }
        if (sub === "draft") {
          if (a.session.messages.length < 3) return void a.say("nothing to learn from yet: finish a task first, then /skills draft", dim);
          a.note("drafting a skill from this conversation…", 60_000); const d = await agent.draftSkill(a.session.messages);
          return void a.commit(["", `  ${green("✓")} drafted ${cyan(d.name)}`, `    ${dim(d.description)}`, dim(`    saved to ${d.file}; it is NOT active. Read it, then /skills approve ${d.name} or /skills reject ${d.name}.`)]);
        }
        if (sub === "drafts") { const l = listDrafts(a.cwd); return void a.say(l.length ? l.map((d) => `${d.name}: ${d.description}`).join("\n") : "no drafts", dim); }
        if (sub === "approve") { if (!name) return void a.say("usage: /skills approve <name>", red); approveDraft(a.cwd, name); return void done(`${name} is active now`); }
        if (sub === "reject") { if (!name) return void a.say("usage: /skills reject <name>", red); rejectDraft(a.cwd, name); return void a.say(`${name} deleted`, dim); }
        a.say(`unknown: /skills ${sub}. Try /skills, show, new, add, remove, on, off, draft`, red);
      } catch (e) { a.say((e as Error).message, red); }
    } },
    { name: "check", help: "fast command run after every edit (typecheck, lint); failures go straight back to the model", args: "[cmd|off]", run: (a, arg) => {
      if (!arg) return void a.say(a.check ? `post-edit check: ${cyan(a.check)}` : "no post-edit check set. /check npx tsc --noEmit", dim);
      a.setCheck(arg === "off" ? undefined : arg); a.say(arg === "off" ? "post-edit check off" : `post-edit check → ${cyan(arg)}`, dim);
    } },
    { name: "verify", help: "command that must pass before it may finish", args: "[cmd|off]", run: (a, arg) => {
      if (!arg) return void a.say(a.verify ? `verify: ${cyan(a.verify)}` : "no verify command set. /verify npm test", dim);
      a.setVerify(arg === "off" ? undefined : arg); a.say(arg === "off" ? "verify gate off" : `verify gate → ${cyan(arg)}`, dim);
    } },
    { name: "live", help: "open the browser live view (diffs stream there)", live: true, run: async (a) => {
      const l = await a.ensureLive(); a.say(`${cyan("●")} live view: ${bold(l.url)}`);
      const { execFile } = await import("node:child_process");
      execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [l.url], () => {});
    } },
    { name: "mcp", help: "attach an MCP server: /mcp <command…> · /mcp list · /mcp off", args: "<command>", run: async (a, arg) => {
      if (!arg || arg === "list") return void a.commit(["", ...(a.mcp.length ? a.mcp.map((m) => `  ${cyan("●")} ${m.cmd}  ${dim(m.tools.length + " tools")}`) : [dim("  no MCP servers attached. /mcp npx -y @modelcontextprotocol/server-filesystem .")])]);
      if (arg === "off") { a.mcp.splice(0).forEach((m) => m.close()); a.buildAgent(); return void a.say("MCP servers detached", dim); }
      const [command, ...rest] = arg.split(/\s+/);
      const prefix = (rest.find((x) => !x.startsWith("-")) ?? command).split("/").pop()!.replace(/\.\w+$/, "").replace(/[^\w]+/g, "_");
      a.note("connecting…", 60_000);
      const h = await loadMcp(command, rest, { prefix }); a.noticeUntil = 0;
      a.mcp.push({ cmd: arg, tools: h.tools, close: h.close }); a.agent.registry.add(...h.tools);
      a.say(`${green("✓")} ${arg}\n${dim(h.tools.length + " tools: " + h.tools.slice(0, 6).map((t) => t.name).join(", ") + (h.tools.length > 6 ? "…" : "") + ". Tools that change things will ask first.")}`);
    } },
    { name: "init", help: "have the agent write AGENTS.md for this repo", run: (a) => a.turn(INIT_PROMPT) },
    { name: "tools", help: "list the tools the agent can use right now", live: true, run: (a) => {
      const vis = a.agent.registry.visible({ step: 0, messages: [] });
      a.commit(["", bold("  Tools"), ...vis.map((t) => `  ${cyan(t.name.padEnd(16))} ${dim(t.description.split(".")[0].slice(0, a.width - 22))}`)]);
    } },
    { name: "status", help: "model, mode, project, session", live: true, run: (a) => {
      a.commit(["", bold("  Status"), `  ${dim("model")}     ${a.cfg.model} ${dim("via " + a.providerInfo().label + (a.model.api ? ` · ${a.model.api()} API` : ""))}`, ...(a.cfg.effort ? [`  ${dim("effort")}    ${a.cfg.effort}`] : []), ...Object.entries(a.wired?.labels ?? {}).map(([r, l]) => `  ${dim(r.padEnd(10))}${l}`), `  ${dim("mode")}      ${a.mode}`, `  ${dim("project")}   ${a.cwd}${a.branch ? dim("  ⎇ " + a.branch) : ""}`,
        `  ${dim("verify")}    ${a.verify ?? "none"}`, `  ${dim("session")}   ${a.session.id} ${dim(`(${a.session.turns.length} turns)`)}`, `  ${dim("memory")}    ${a.memory?.list().length ?? 0} notes`, `  ${dim("sandbox")}   ${a.cfg.sandbox ?? "off"}`, `  ${dim("trace")}     ${a.tracer?.file ? a.tracer.file.replace(a.cwd + "/", "") : "(after the first message)"}`, `  ${dim("instructions")} ${a.agent.guidance?.files.join(", ") || "none loaded (add an AGENTS.md)"}`, `  ${dim("running")}   ${a.running ? "yes, " + fmtDuration(Date.now() - a.runStart) : "no"}`]);
    } },
    { name: "theme", help: "colour theme (live preview)", args: "[name]", run: async (a, arg) => {
      const prev = a.cfg.theme;
      const choose = (n: string | undefined) => { a.cfg.theme = n ?? prev; a.full?.invalidate(); a.render(); };
      let name: string | undefined = arg;
      if (!name) {
        name = await a.pick("Theme", themeNames().map((n) => ({ label: THEMES[n].label, value: n, hint: THEMES[n].dark ? "dark" : "light" })), Math.max(0, themeNames().indexOf(getTheme(prev).name)), (v) => choose(v));
        if (!name) { choose(prev); return; }
      }
      if (!THEMES[name]) { choose(prev); return void a.say(`unknown theme "${name}". Try: ${themeNames().join(", ")}`, red); }
      choose(name); a.saveConfig(); a.say(`theme → ${cyan(THEMES[name].label)}${a.full ? "" : dim("  (themes apply to the full-screen UI; try /ui full)")}`, dim);
    } },
    { name: "sidebar", help: "show or hide the side panel", alias: "side", live: true, run: (a) => { if (!a.full) return void a.say("the side panel is part of the full-screen UI (/ui full)", dim); a.full.showSidebar = !a.full.showSidebar; a.full.invalidate(); } },
    { name: "details", help: "expand or collapse all tool output", live: true, run: (a) => { if (!a.full) return void a.say("full-screen UI only (/ui full)", dim); a.full.expandAll = !a.full.expandAll; a.full.toast(a.full.expandAll ? "all tool output expanded" : "tool output collapsed"); } },
    { name: "diffmode", help: "diff layout: auto · stacked · split", args: "[mode]", live: true, run: (a, arg) => {
      if (!a.full) return void a.say("full-screen UI only (/ui full)", dim);
      if (!["auto", "stacked", "split"].includes(arg)) return void a.say(`diff layout is ${cyan(a.full.diffMode)}. Choose: auto, stacked, split`, dim);
      a.full.diffMode = arg as "auto"; a.full.invalidate(); a.say(`diff layout → ${cyan(arg)}`, dim);
    } },
    { name: "mouse", help: "mouse on/off (off restores native text selection)", args: "[on|off]", live: true, run: (a, arg) => { if (!a.full) return void a.say("full-screen UI only (/ui full)", dim); a.full.setMouse(arg ? arg !== "off" : !a.full.mouseOn); } },
    { name: "ui", help: "switch between the full-screen and inline UI", args: "[full|inline]", run: (a, arg) => {
      const to = arg === "full" || arg === "inline" ? arg : a.ui === "full" ? "inline" : "full";
      a.cfg.ui = to; a.saveConfig();
      if (to === a.ui) return void a.say(`already using the ${to} UI`, dim);
      a.switchUi(to);
    } },
    { name: "exit", alias: "quit", help: "leave", live: true, run: (a) => a.exit(0) },
  ];
}


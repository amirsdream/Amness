import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { deleteSecret, getSecret, noStore, setSecret } from "./keystore.ts";

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1", needsKey: true },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", needsKey: false },
  custom: { label: "Custom OpenAI-compatible", baseUrl: "http://localhost:8000/v1", model: "my-model", needsKey: false },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
/** A server you set up once and pick again by name: a custom OpenAI-compatible server (vLLM, llama.cpp, LM Studio, a gateway) or an Ollama. Its key is saved under its own name. */
export type Server = { name: string; provider: "custom" | "ollama"; baseUrl: string; model: string };
/** Whose key: a provider's, or one saved server's (`server:<name>`), so a token never goes to another server. */
export type KeyId = ProviderId | `server:${string}`;
export const serverKey = (name: string): KeyId => `server:${name}`;
/** The key slot of the provider or server in use. */
export const keyIdOf = (c: Pick<Config, "provider" | "server">): KeyId => (c.server ? serverKey(c.server) : c.provider);
/** A short default name for a server: its host and port ("llm.example.com", "localhost:8000"), or "ollama" for the usual local Ollama. */
export const serverName = (provider: Server["provider"], baseUrl: string): string => {
  if (provider === "ollama" && baseUrl.replace(/\/+$/, "") === PROVIDERS.ollama.baseUrl) return "ollama";
  try { return new URL(baseUrl).host || baseUrl; } catch { return baseUrl; }
};
/** Add or replace (same name) a saved server, and make it the one in use. */
export function useServer(c: Config, s: Server) {
  const list = c.servers ?? [], i = list.findIndex((x) => x.name === s.name);
  c.servers = i < 0 ? [...list, s] : list.map((x, k) => (k === i ? s : x));   // a server keeps its place in the list
  Object.assign(c, { provider: s.provider, baseUrl: s.baseUrl, model: s.model, server: s.name, apiKey: keyFor(serverKey(s.name)).key });
}
/** Forget a saved server and its key. If it was in use, the config falls back to its provider's defaults. */
export function forgetServer(c: Config, name: string) {
  c.servers = (c.servers ?? []).filter((x) => x.name !== name); storeKey(serverKey(name), undefined);
  if (c.server === name) { c.server = undefined; c.apiKey = keyFor(c.provider).key; }
}

export type Config = { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; /** saved keys for the other providers and servers, only where there is no OS store */ apiKeys?: Partial<Record<KeyId, string>>; /** custom and Ollama servers you set up, to pick again with /provider */ servers?: Server[]; /** the saved server in use (its name), when the provider is custom or ollama */ server?: string; tavilyKey?: string; maxTokens: number; effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; /** OpenAI wire API: auto (default) picks Responses for reasoning models and self-corrects */ api?: "auto" | "responses" | "chat"; /** full-screen colour theme (see /theme) */ theme?: string; /** which UI to start in */ ui?: "full" | "inline"; /** vim-style editing in the input box (see /vim) */ vim?: boolean; /** the agent loop's own settings (see /harness): guards switched off, step limit, no-progress limit, context budget, cost-aware rewrites */ harness?: { off?: string[]; maxSteps?: number; stagnationTurns?: number; contextBudget?: number; governRewrites?: boolean }; /** the desktop app's own preferences (appearance, layout, what folds); kept here so they survive restarts and travel with the rest of the settings */ desktop?: Record<string, unknown>; /** desktop notification when a long turn ends or approval is needed while the terminal is in the background (default on) */ notify?: "on" | "off"; /** while idle, re-send the conversation now and then so the provider keeps its prompt cache (Claude: the cache expires after 5 minutes) */ keepWarm?: boolean; /** semantic memory retrieval via an OpenAI-compatible embeddings endpoint (sends note text to that provider) */ embeddings?: boolean; /** which shell runs the agent's commands: auto (default), bash, zsh, sh, pwsh, powershell or cmd (see /shell) */ shell?: string; /** a system prompt id from .amness/prompts (see /prompt) */ prompt?: string; /** a loop strategy: plan-first or explore-then-act (see /strategy) */ strategy?: string; /** most model requests in flight at once, shared by the lead agent and its subagents (default 4); halves automatically on a 429 and ramps back up */ maxConcurrent?: number; /** OpenAI Responses only: server-side compaction once the prompt passes this many tokens */ compactAt?: number; /** offer the plan of a similar finished task and keep plans of finished tasks (see /plans); off until measured */ plans?: boolean; /** the model's context window in tokens, for small or local models (8192); unset = learn it from the provider's "context too long" error. AMNESS_CONTEXT_WINDOW overrides. */ contextWindow?: number; /** windows learned from provider errors, per model id */ windows?: Record<string, number>; /** Claude only: advisory token budget per turn (task_budget, beta; at least 20000) */ taskBudget?: number; /** a second model reviews risky calls before you are asked (extra model call per risky action) */ approvalReviewer?: boolean; /** errors from an installed language server are appended to edit results */ lsp?: boolean; /** an independent reviewer checks finished work against acceptance criteria (extra model calls) */ review?: boolean; /** dual LLM: untrusted tool output (web, MCP) is read by a separate tool-less model call first; the agent sees only its digest (an extra call per untrusted result) */ quarantine?: boolean; /** OS sandbox for shell commands */ sandbox?: "off" | "workspace" | "strict"; /** which engine runs sandboxed commands: auto (Seatbelt on macOS, Bubblewrap on Linux), docker, or one a plugin adds */ sandboxEngine?: string; /** docker engine: the image commands run in, and the runtime (runsc = gVisor) */ sandboxImage?: string; sandboxRuntime?: string; /** models for other roles, as references (a bare id on the main provider, provider:model, or server:<name>[/model]; see cli/roles.ts); unset roles use `model` */ models?: { explore?: string; compact?: string; review?: string; cheap?: string; approve?: string; quarantine?: string; advisor?: string }; /** route exploration steps to models.cheap when that pays off (cache-aware) */ router?: boolean; /** the explorer answers with checked file ranges instead of prose (not measured) */ exploreRanges?: boolean; /** how much a token of a local-tier model counts against the token cap (0 to 1; default 1) */ budgetLocalWeight?: number; /** the recovery ladder: model references, cheapest first; the run starts at ladderStart (default 0) and moves up on accumulated trouble, down after a clean stretch */ ladder?: string[]; ladderStart?: number; /** the advisor (models.advisor): consultations per request and per conversation, tokens per advice, prompt caching */ advisor?: { maxUses?: number; cap?: number; maxTokens?: number; caching?: "5m" | "1h" }; /** keep the tool list fixed for the session (tool_search + call_tool), so loading a tool does not break the prompt cache */ stableTools?: boolean; /** model id to answer from when the main one is overloaded or unreachable */ fallback?: string };
/** The context window to manage for this model: the environment, then the config, then one learned from an earlier error. Undefined means "unknown": the loop learns it from the first overflow. */
export const windowFor = (c: Pick<Config, "model" | "contextWindow" | "windows">): number | undefined => {
  const n = Number(process.env.AMNESS_CONTEXT_WINDOW) || c.contextWindow || c.windows?.[c.model]; return n && n >= 512 ? Math.floor(n) : undefined;
};
/** Remember a window learned from a provider error, so the next session starts with it. */
export const rememberWindow = (c: Config, tokens: number, model = c.model) => { c.windows = { ...c.windows, [model]: tokens }; try { saveConfig(c); } catch { /* read-only home: the next session learns it again */ } };
export const home = () => process.env.AMNESS_HOME ?? join(homedir(), ".amness");
const file = () => join(home(), "config.json");

export const defaults = (): Config => ({ provider: "openai", baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.model, maxTokens: 300_000 });

// ---- keys. One saved key per provider (account "apiKey-<provider>" in the OS store), so you can be connected to several at once. `cfg.apiKey` is always the active provider's key.
const acct = (p: KeyId) => `apiKey-${p}`;
let fileKeys: Partial<Record<KeyId, string>> = {}, fileKeysLoaded = false;     // only where there is no OS store (a Linux server): kept in config.json, mode 600
const sessionKeys: Partial<Record<KeyId, string>> = {}; // in a container: this run only
const persisted: Partial<Record<KeyId, string | undefined>> = {}; // what is stored now, so a save does not rewrite an unchanged key

/** An environment variable, or the file NAME_FILE points to (Docker and Kubernetes secrets are mounted as files, for example /run/secrets/openai). */
const envSecret = (name: string): string | undefined => {
  const v = process.env[name]; if (v) return v;
  const f = process.env[`${name}_FILE`]; if (!f) return undefined;
  try { return readFileSync(f, "utf8").trim() || undefined; } catch { return undefined; }
};
/** The variable that holds a provider's key. Anthropic has its own; OpenRouter may have its own; every other provider (and every saved server) uses OPENAI_API_KEY. */
export const envNameFor = (p: KeyId) => (p === "anthropic" ? "ANTHROPIC_API_KEY" : p === "openrouter" && envSecret("OPENROUTER_API_KEY") ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");
export const envKeyFor = (p: KeyId) => envSecret(envNameFor(p));
const loadFileKeys = () => { if (!fileKeysLoaded) { fileKeysLoaded = true; fileKeys = { ...readFileCfg().apiKeys }; } };
const savedKey = (p: KeyId) => { loadFileKeys(); return getSecret(acct(p)) ?? fileKeys[p] ?? sessionKeys[p]; };

export type KeyState = { key?: string; source: "env" | "saved" | "none" };
/** The key to use for a provider: an environment variable wins over a saved key. */
export function keyFor(p: KeyId): KeyState {
  const e = envKeyFor(p); if (e) return { key: e, source: "env" };
  const s = savedKey(p); if (s) { persisted[p] = s; return { key: s, source: "saved" }; }
  return { source: "none" };
}

/** Save (or, with no key, remove) a provider's key. Uses the OS store; else config.json (mode 600); in a container, memory only. */
export function storeKey(p: KeyId, key?: string) {
  loadFileKeys(); persisted[p] = key;
  if (!key) { deleteSecret(acct(p)); delete fileKeys[p]; delete sessionKeys[p]; writeConfigFile(readFileCfg()); return; }
  if (setSecret(acct(p), key)) { delete fileKeys[p]; delete sessionKeys[p]; }
  else if (noStore()) sessionKeys[p] = key;
  else fileKeys[p] = key;
  writeConfigFile(readFileCfg());
}

export type Connection = { id: KeyId; label: string; needsKey: boolean; source: KeyState["source"]; env: string; /** set for a saved server */ server?: Server };
/** The cloud providers and every saved server, and whether each has a key. Custom and Ollama appear as their saved servers. */
export function connections(c?: Pick<Config, "servers">): Connection[] {
  const cloud = (["anthropic", "openai", "openrouter"] as const).map((id) => ({ id, label: PROVIDERS[id].label, needsKey: true, source: keyFor(id).source, env: envNameFor(id) }));
  return [...cloud, ...(c?.servers ?? []).map((s) => { const id = serverKey(s.name); return { id, label: s.name, needsKey: false, source: keyFor(id).source, env: envNameFor(id), server: s }; })];
}

const readFileCfg = (): Config => { try { return { ...defaults(), ...JSON.parse(readFileSync(file(), "utf8")) }; } catch { return defaults(); } };
let tavilyEnv: string | undefined;

export function loadConfig(): Config {
  let c = defaults(), onDisk: Partial<Config> = {};
  try { if (existsSync(file())) onDisk = JSON.parse(readFileSync(file(), "utf8")); c = { ...c, ...onDisk }; } catch { /* corrupt config: start fresh */ }
  fileKeys = { ...onDisk.apiKeys }; fileKeysLoaded = true; delete c.apiKeys;
  let dirty = false;
  // older versions kept ONE key (account "apiKey", or a field in the file) for whichever provider was active: give it to that provider
  const legacy = [getSecret("apiKey"), onDisk.apiKey].find(Boolean);
  if (legacy && !savedKey(c.provider)) { fileKeys[c.provider] = legacy; dirty = true; }
  if (getSecret("apiKey")) deleteSecret("apiKey");
  if (onDisk.apiKey) { delete onDisk.apiKey; dirty = true; }
  // keys still in the file move to the OS store, and leave the file only after they read back
  for (const p of Object.keys(fileKeys) as KeyId[]) if (fileKeys[p] && setSecret(acct(p), fileKeys[p]!)) { delete fileKeys[p]; dirty = true; }
  const tv = getSecret("tavilyKey") ?? onDisk.tavilyKey;
  if (onDisk.tavilyKey && setSecret("tavilyKey", onDisk.tavilyKey)) { delete onDisk.tavilyKey; dirty = true; }
  if (dirty) writeConfigFile({ ...defaults(), ...onDisk, apiKey: undefined, tavilyKey: onDisk.tavilyKey } as Config);
  // a custom or Ollama server set up before servers were remembered becomes the first saved one, with a copy of its key
  if ((c.provider === "custom" || c.provider === "ollama") && !c.server && !(c.servers ?? []).length) {
    const name = serverName(c.provider, c.baseUrl), k = savedKey(c.provider);
    c.servers = [{ name, provider: c.provider, baseUrl: c.baseUrl, model: c.model }]; c.server = name;
    if (k) storeKey(serverKey(name), k);
    writeConfigFile({ ...readFileCfg(), servers: c.servers, server: name });
  }
  if (c.server && !(c.servers ?? []).some((s) => s.name === c.server)) c.server = undefined;        // a server removed by hand
  const claude = c.provider === "anthropic";
  c.apiKey = keyFor(keyIdOf(c)).key;
  // environment wins, so CI and one-off runs work without touching the saved key. It is never written back (see saveConfig).
  tavilyEnv = envSecret("TAVILY_API_KEY"); c.tavilyKey = tavilyEnv ?? tv;
  if (process.env.OPENAI_BASE_URL && !claude) c.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.AMNESS_MODEL) c.model = process.env.AMNESS_MODEL;
  remember(c);
  return c;
}

// Several windows (two terminals, chats in the desktop app) each hold their own copy of the config. Saving a copy writes only the keys that copy
// changed since it was loaded, merged into the file as it is now, so one window never undoes another window's settings.
const SKIP = new Set(["apiKey", "apiKeys", "tavilyKey"]);
const baselines = new WeakMap<Config, Map<string, string>>();
const snapshot = (c: object) => new Map(Object.entries(c).filter(([k]) => !SKIP.has(k)).map(([k, v]) => [k, JSON.stringify(v) ?? "undefined"]));
const remember = (c: Config) => { baselines.set(c, snapshot(c)); };
/** A separate copy of the config (a desktop chat with its own provider and model). Saving it writes only what it changed. */
export function cloneConfig(c: Config): Config { const copy = structuredClone(c); remember(copy); const l = layers.get(c); if (l) layers.set(copy, { ...l, from: new Map(l.from), to: undefined, notes: [] }); return copy; }

function writeConfigFile(c: Config) {
  mkdirSync(home(), { recursive: true });
  const out: Config = { ...c, apiKeys: Object.keys(fileKeys).length ? fileKeys : undefined };
  writeFileSync(file(), JSON.stringify(out, null, 2), { mode: 0o600 }); // owner-only from the first byte
  chmodSync(file(), 0o600); // and for a file that already existed
}

/** Save what changed, each key to its layer. `write: false` only keeps the books (where each value now comes from), for a run that saves nothing. */
export function saveConfig(c: Config, o: { write?: boolean } = {}): Set<Layer> {
  if (o.write === false) { const base = baselines.get(c), info = layers.get(c), now = snapshot(c); if (base && info) for (const k of new Set([...now.keys(), ...base.keys()])) if (!SKIP.has(k) && now.get(k) !== base.get(k)) { const to = targetOf(c, k); if (to !== "user") info.from.set(k, to); else if (info.parent) (info.parent as Record<string, unknown>)[k] = (c as Record<string, unknown>)[k]; } remember(c); return new Set(); }
  if (c.server) c.servers = (c.servers ?? []).map((s) => (s.name === c.server ? { ...s, provider: c.provider === "ollama" ? "ollama" : "custom", baseUrl: c.baseUrl, model: c.model } : s));   // /model or a new address on a saved server is remembered with it
  const out: Config = { ...c }; delete out.apiKey; delete out.apiKeys;
  const id = keyIdOf(c);
  if (c.apiKey !== persisted[id] && !(c.apiKey && c.apiKey === envKeyFor(id))) storeKey(id, c.apiKey); // a key from an environment variable is never stored
  const tv = c.tavilyKey;
  if (tv && tv === tavilyEnv) delete out.tavilyKey;
  else if (!tv) { deleteSecret("tavilyKey"); delete out.tavilyKey; }
  else if (setSecret("tavilyKey", tv) || noStore()) delete out.tavilyKey;
  const base = baselines.get(c), info = layers.get(c), written = new Set<Layer>();
  if (!base) { writeConfigFile(out); return written; }
  const disk = readFileCfg() as Record<string, unknown>, merged: Record<string, unknown> = { ...disk }, now = snapshot(out);
  const files: Partial<Record<"project" | "team", Record<string, unknown>>> = {};
  for (const k of new Set([...now.keys(), ...base.keys()])) {
    if (SKIP.has(k) || now.get(k) === base.get(k)) continue;
    const v = (out as Record<string, unknown>)[k], to = targetOf(c, k);
    if (info && to !== "user") info.from.set(k, to);
    if (to === "chat") continue;                                                        // this conversation only: nothing is written
    if (to === "project" || to === "team") { const f = (files[to] ??= readJson(projectFile(info!.root, to)) ?? {}); if (v === undefined) delete f[k]; else f[k] = v; continue; }
    if (v === undefined) delete merged[k]; else merged[k] = v;
    if (info?.parent) (info.parent as Record<string, unknown>)[k] = v;                 // the shared copy other chats start from sees it too
    written.add("user");
  }
  if (out.tavilyKey) merged.tavilyKey = out.tavilyKey; else delete merged.tavilyKey;
  delete merged.apiKey; delete merged.apiKeys;
  writeConfigFile(merged as Config);
  for (const [layer, f] of Object.entries(files) as ["project" | "team", Record<string, unknown>][]) { writeProjectFile(info!.root, layer, f); written.add(layer); }
  remember(c); return written;
}

// ---- layers. Like Claude Code: ~/.amness/config.json (you, every project) < .amness/settings.json (the team's, in the repository; applies only after you
// trust that exact file, and cannot set keys, servers or loosen safety) < .amness/settings.local.json (you, this project; kept out of git) < this chat.
/** Where a setting's value comes from, and where a change to it is saved. */
export type Layer = "user" | "team" | "project" | "chat";
type LayerInfo = { root: string; from: Map<string, Layer>; to?: Layer; parent?: Config; notes: string[] };
const layers = new WeakMap<Config, LayerInfo>();
/** Never read from a project file: they choose where your key goes, or are about you and not the code. */
const PERSONAL = new Set(["provider", "baseUrl", "apiKey", "apiKeys", "server", "servers", "tavilyKey", "windows", "desktop"]);
/** Also never from the team file: they loosen safety or run something the repository picks. */
const NOT_FROM_TEAM = new Set(["approvalReviewer", "sandboxEngine", "sandboxImage", "sandboxRuntime", "shell", "keepWarm", "notify", "embeddings"]);
/** Saved to this project by default: they depend on the code (its tests, language server, risk, task size). Everything else is saved for all your projects. */
export const PROJECT_KEYS = new Set(["sandbox", "sandboxEngine", "sandboxImage", "sandboxRuntime", "lsp", "review", "quarantine", "approvalReviewer", "exploreRanges", "harness", "maxTokens", "taskBudget", "compactAt", "shell", "strategy", "prompt", "plans", "stableTools"]);
const SANDBOX_ORDER = ["off", "workspace", "strict"];

export const projectFile = (root: string, layer: "project" | "team") => join(root, ".amness", layer === "team" ? "settings.json" : "settings.local.json");
export const readJson = (f: string): Record<string, unknown> | undefined => { try { if (!existsSync(f)) return undefined; const j = JSON.parse(readFileSync(f, "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : undefined; } catch { return undefined; } };
const git = (root: string, args: string[]) => { try { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); return r.status === 0 ? r.stdout.trim() : undefined; } catch { return undefined; } };
/** A "local" file that git tracks came with the repository: it is not yours, so it is not used. */
export const tracked = (root: string, f: string) => git(root, ["ls-files", "--error-unmatch", f]) !== undefined;
export function writeProjectFile(root: string, layer: "project" | "team", f: Record<string, unknown>) {
  const file = projectFile(root, layer); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(f, null, 2) + "\n");
  if (layer === "project") {                                                            // keep your file out of commits, as Claude Code does
    const ex = git(root, ["rev-parse", "--git-path", "info/exclude"]); if (!ex) return;
    const path = isAbsolute(ex) ? ex : join(root, ex), line = ".amness/settings.local.json";
    try { const cur = existsSync(path) ? readFileSync(path, "utf8") : ""; if (!cur.split(/\r?\n/).includes(line)) { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n"); } } catch { /* not fatal */ }
  }
}
function applyLayer(c: Config, j: Record<string, unknown>, layer: "team" | "project", info: LayerInfo) {
  const cfg = c as Record<string, unknown>;
  for (const [k, v] of Object.entries(j)) {
    if (k === "mcpServers") continue;                                                          // read on its own by cli/mcpconfig.ts (with its own trust rules)
    if (PERSONAL.has(k) || (layer === "team" && NOT_FROM_TEAM.has(k))) { info.notes.push(`${k} in ${layer === "team" ? ".amness/settings.json" : ".amness/settings.local.json"} is ignored: set it for yourself`); continue; }
    if (layer === "team" && k === "sandbox" && SANDBOX_ORDER.indexOf(String(v)) < SANDBOX_ORDER.indexOf(String(cfg.sandbox ?? "off"))) { info.notes.push(`the team file asks for a weaker sandbox (${v}); yours is kept`); continue; }
    if (layer === "team" && (k === "review" || k === "quarantine") && v !== true) continue;   // the team may only switch these checks on
    if (layer === "team" && k === "harness" && v && typeof v === "object") { const { off: _off, ...rest } = v as Record<string, unknown>; cfg[k] = { ...(cfg[k] as object), ...rest }; info.from.set(k, layer); continue; }   // nor switch guards off
    cfg[k] = v; info.from.set(k, layer);
  }
}
/**
 * The settings for a project: a copy of `c` with the project's own files on top. `teamTrusted` says whether you approved this version of
 * .amness/settings.json (it is part of the hooks and rules fingerprint). The copy remembers the layers, so a change is saved where it belongs.
 */
export function forProject(c: Config, root: string, o: { teamTrusted: boolean }): Config {
  const out = structuredClone(c), info: LayerInfo = { root, from: new Map(), parent: layers.get(c)?.parent ?? c, notes: [] };
  const team = readJson(projectFile(root, "team")), local = readJson(projectFile(root, "project"));
  if (team && o.teamTrusted) applyLayer(out, team, "team", info);
  if (local) { if (tracked(root, projectFile(root, "project"))) info.notes.push(".amness/settings.local.json is ignored: git tracks it, so it came with the repository (remove it from git to use it)"); else applyLayer(out, local, "project", info); }
  layers.set(out, info); remember(out); return out;
}
/** Apply the team file after you trusted it (the chat started before you answered). */
export function applyTeam(c: Config) {
  const info = layers.get(c); if (!info) return; const team = readJson(projectFile(info.root, "team")); if (!team) return;
  const before = snapshot(c); applyLayer(c, team, "team", info);
  const base = baselines.get(c); if (base) for (const [k, v] of snapshot(c)) if (before.get(k) !== v) base.set(k, v);   // not a change of yours: nothing to save
}
/** Where the value of `key` comes from now. */
export function sourceOf(c: Config, key: string): Layer | "default" {
  const l = layers.get(c)?.from.get(key); if (l) return l;
  return key in readFileCfg() && !(key in defaults() && JSON.stringify((readFileCfg() as Record<string, unknown>)[key]) === JSON.stringify((defaults() as Record<string, unknown>)[key])) ? "user" : "default";
}
/** Where a change to `key` is saved: the layer you chose for this change, else where its value comes from (a team value is overridden in your own project file), else its usual place. */
export function targetOf(c: Config, key: string): Layer {
  const info = layers.get(c); if (!info) return "user";
  if (info.to) return info.to;
  const f = info.from.get(key); if (f) return f === "team" ? "project" : f;
  return PROJECT_KEYS.has(key) ? "project" : "user";
}
/** Save the next changes to this layer (undefined: back to the usual places). */
export function saveTo(c: Config, layer?: Layer) { const info = layers.get(c); if (info) info.to = layer; }
export const layerNotes = (c: Config) => layers.get(c)?.notes ?? [];
export const projectRootOf = (c: Config) => layers.get(c)?.root;

export const ready = (c: Config) => !PROVIDERS[c.provider].needsKey || !!c.apiKey;
export const mask = (k?: string) => (k ? k.slice(0, 3) + "…" + k.slice(-4) : "not set");

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", hint: "most capable everyday model · $4/$20 per M tokens (default)" },
  { id: "claude-sonnet-5-5", hint: "fast and cheaper · $2/$10" },
  { id: "claude-haiku-5-5", hint: "cheapest · $0.10/$0.50 · no refusal fallback" },
  { id: "claude-fable-5-1", hint: "hardest tasks · $10/$50" },
];

export const OPENAI_MODELS = [
  { id: "gpt-6.1-sol", hint: "near-flagship for complex work · $2/$10 per M tokens (default)" },
  { id: "gpt-6-astra", hint: "flagship, hardest tasks · $10/$50" },
  { id: "gpt-6.1-terra", hint: "fast + efficient, computer use · $1/$5" },
  { id: "gpt-6-luna", hint: "cheap, high-volume · $0.10/$0.50" },
  { id: "gpt-5.6-luna", hint: "previous generation" },
  { id: "gpt-4.1", hint: "non-reasoning · Chat Completions" },
];

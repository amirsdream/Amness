import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deleteSecret, getSecret, noStore, setSecret } from "./keystore.ts";

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1", needsKey: true },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", needsKey: false },
  custom: { label: "Custom OpenAI-compatible", baseUrl: "http://localhost:8000/v1", model: "my-model", needsKey: false },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export type Config = { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; /** saved keys for the other providers, only where there is no OS store */ apiKeys?: Partial<Record<ProviderId, string>>; tavilyKey?: string; maxTokens: number; effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; /** OpenAI wire API: auto (default) picks Responses for reasoning models and self-corrects */ api?: "auto" | "responses" | "chat"; /** full-screen colour theme (see /theme) */ theme?: string; /** which UI to start in */ ui?: "full" | "inline"; /** while idle, re-send the conversation now and then so the provider keeps its prompt cache (Claude: the cache expires after 5 minutes) */ keepWarm?: boolean; /** semantic memory retrieval via an OpenAI-compatible embeddings endpoint (sends note text to that provider) */ embeddings?: boolean; /** which shell runs the agent's commands: auto (default), bash, zsh, sh, pwsh, powershell or cmd (see /shell) */ shell?: string; /** a system prompt id from .amness/prompts (see /prompt) */ prompt?: string; /** a loop strategy: plan-first or explore-then-act (see /strategy) */ strategy?: string; /** most model requests in flight at once, shared by the lead agent and its subagents (default 4); halves automatically on a 429 and ramps back up */ maxConcurrent?: number; /** OpenAI Responses only: server-side compaction once the prompt passes this many tokens */ compactAt?: number; /** Claude only: advisory token budget per turn (task_budget, beta; at least 20000) */ taskBudget?: number; /** a second model reviews risky calls before you are asked (extra model call per risky action) */ approvalReviewer?: boolean; /** errors from an installed language server are appended to edit results */ lsp?: boolean; /** an independent reviewer checks finished work against acceptance criteria (extra model calls) */ review?: boolean; /** OS sandbox for shell commands */ sandbox?: "off" | "workspace" | "strict"; /** model ids (same provider) for other roles; unset roles use `model` */ models?: { explore?: string; compact?: string; review?: string; cheap?: string }; /** route exploration steps to models.cheap when that pays off (cache-aware) */ router?: boolean; /** model id to answer from when the main one is overloaded or unreachable */ fallback?: string };
export const home = () => process.env.AMNESS_HOME ?? join(homedir(), ".amness");
const file = () => join(home(), "config.json");

export const defaults = (): Config => ({ provider: "openai", baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.model, maxTokens: 300_000 });

// ---- keys. One saved key per provider (account "apiKey-<provider>" in the OS store), so you can be connected to several at once. `cfg.apiKey` is always the active provider's key.
const acct = (p: ProviderId) => `apiKey-${p}`;
let fileKeys: Partial<Record<ProviderId, string>> = {}, fileKeysLoaded = false;     // only where there is no OS store (a Linux server): kept in config.json, mode 600
const sessionKeys: Partial<Record<ProviderId, string>> = {}; // in a container: this run only
const persisted: Partial<Record<ProviderId, string | undefined>> = {}; // what is stored now, so a save does not rewrite an unchanged key

/** An environment variable, or the file NAME_FILE points to (Docker and Kubernetes secrets are mounted as files, for example /run/secrets/openai). */
const envSecret = (name: string): string | undefined => {
  const v = process.env[name]; if (v) return v;
  const f = process.env[`${name}_FILE`]; if (!f) return undefined;
  try { return readFileSync(f, "utf8").trim() || undefined; } catch { return undefined; }
};
/** The variable that holds a provider's key. Anthropic has its own; OpenRouter may have its own; every other provider uses OPENAI_API_KEY. */
export const envNameFor = (p: ProviderId) => (p === "anthropic" ? "ANTHROPIC_API_KEY" : p === "openrouter" && envSecret("OPENROUTER_API_KEY") ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");
export const envKeyFor = (p: ProviderId) => envSecret(envNameFor(p));
const loadFileKeys = () => { if (!fileKeysLoaded) { fileKeysLoaded = true; fileKeys = { ...readFileCfg().apiKeys }; } };
const savedKey = (p: ProviderId) => { loadFileKeys(); return getSecret(acct(p)) ?? fileKeys[p] ?? sessionKeys[p]; };

export type KeyState = { key?: string; source: "env" | "saved" | "none" };
/** The key to use for a provider: an environment variable wins over a saved key. */
export function keyFor(p: ProviderId): KeyState {
  const e = envKeyFor(p); if (e) return { key: e, source: "env" };
  const s = savedKey(p); if (s) { persisted[p] = s; return { key: s, source: "saved" }; }
  return { source: "none" };
}

/** Save (or, with no key, remove) a provider's key. Uses the OS store; else config.json (mode 600); in a container, memory only. */
export function storeKey(p: ProviderId, key?: string) {
  loadFileKeys(); persisted[p] = key;
  if (!key) { deleteSecret(acct(p)); delete fileKeys[p]; delete sessionKeys[p]; writeConfigFile(readFileCfg()); return; }
  if (setSecret(acct(p), key)) { delete fileKeys[p]; delete sessionKeys[p]; }
  else if (noStore()) sessionKeys[p] = key;
  else fileKeys[p] = key;
  writeConfigFile(readFileCfg());
}

export type Connection = { id: ProviderId; label: string; needsKey: boolean; source: KeyState["source"]; env: string };
/** Every provider and whether it is ready to use. */
export function connections(): Connection[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({ id, label: PROVIDERS[id].label, needsKey: PROVIDERS[id].needsKey, source: PROVIDERS[id].needsKey ? keyFor(id).source : "saved", env: envNameFor(id) }));
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
  for (const p of Object.keys(fileKeys) as ProviderId[]) if (fileKeys[p] && setSecret(acct(p), fileKeys[p]!)) { delete fileKeys[p]; dirty = true; }
  const tv = getSecret("tavilyKey") ?? onDisk.tavilyKey;
  if (onDisk.tavilyKey && setSecret("tavilyKey", onDisk.tavilyKey)) { delete onDisk.tavilyKey; dirty = true; }
  if (dirty) writeConfigFile({ ...defaults(), ...onDisk, apiKey: undefined, tavilyKey: onDisk.tavilyKey } as Config);
  const claude = c.provider === "anthropic";
  c.apiKey = keyFor(c.provider).key;
  // environment wins, so CI and one-off runs work without touching the saved key. It is never written back (see saveConfig).
  tavilyEnv = envSecret("TAVILY_API_KEY"); c.tavilyKey = tavilyEnv ?? tv;
  if (process.env.OPENAI_BASE_URL && !claude) c.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.AMNESS_MODEL) c.model = process.env.AMNESS_MODEL;
  return c;
}

function writeConfigFile(c: Config) {
  mkdirSync(home(), { recursive: true });
  const out: Config = { ...c, apiKeys: Object.keys(fileKeys).length ? fileKeys : undefined };
  writeFileSync(file(), JSON.stringify(out, null, 2), { mode: 0o600 }); // owner-only from the first byte
  chmodSync(file(), 0o600); // and for a file that already existed
}

export function saveConfig(c: Config) {
  const out: Config = { ...c }; delete out.apiKey; delete out.apiKeys;
  if (c.apiKey !== persisted[c.provider] && !(c.apiKey && c.apiKey === envKeyFor(c.provider))) storeKey(c.provider, c.apiKey); // a key from an environment variable is never stored
  const tv = c.tavilyKey;
  if (tv && tv === tavilyEnv) delete out.tavilyKey;
  else if (!tv) { deleteSecret("tavilyKey"); delete out.tavilyKey; }
  else if (setSecret("tavilyKey", tv) || noStore()) delete out.tavilyKey;
  writeConfigFile(out);
}

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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deleteSecret, getSecret, setSecret } from "./keystore.ts";

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1", needsKey: true },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", needsKey: false },
  custom: { label: "Custom OpenAI-compatible", baseUrl: "http://localhost:8000/v1", model: "my-model", needsKey: false },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export type Config = { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; tavilyKey?: string; maxTokens: number; effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; /** OpenAI wire API: auto (default) picks Responses for reasoning models and self-corrects */ api?: "auto" | "responses" | "chat"; /** full-screen colour theme (see /theme) */ theme?: string; /** which UI to start in */ ui?: "full" | "inline"; /** while idle, re-send the conversation now and then so the provider keeps its prompt cache (Claude: the cache expires after 5 minutes) */ keepWarm?: boolean; /** semantic memory retrieval via an OpenAI-compatible embeddings endpoint (sends note text to that provider) */ embeddings?: boolean; /** which shell runs the agent's commands: auto (default), bash, zsh, sh, pwsh, powershell or cmd (see /shell) */ shell?: string; /** a system prompt id from .amness/prompts (see /prompt) */ prompt?: string; /** a loop strategy: plan-first or explore-then-act (see /strategy) */ strategy?: string; /** most model requests in flight at once, shared by the lead agent and its subagents (default 4); halves automatically on a 429 and ramps back up */ maxConcurrent?: number; /** OpenAI Responses only: server-side compaction once the prompt passes this many tokens */ compactAt?: number; /** Claude only: advisory token budget per turn (task_budget, beta; at least 20000) */ taskBudget?: number; /** a second model reviews risky calls before you are asked (extra model call per risky action) */ approvalReviewer?: boolean; /** errors from an installed language server are appended to edit results */ lsp?: boolean; /** an independent reviewer checks finished work against acceptance criteria (extra model calls) */ review?: boolean; /** OS sandbox for shell commands */ sandbox?: "off" | "workspace" | "strict"; /** model ids (same provider) for other roles; unset roles use `model` */ models?: { explore?: string; compact?: string; review?: string; cheap?: string }; /** route exploration steps to models.cheap when that pays off (cache-aware) */ router?: boolean; /** model id to answer from when the main one is overloaded or unreachable */ fallback?: string };
export const home = () => process.env.AMNESS_HOME ?? join(homedir(), ".amness");
const file = () => join(home(), "config.json");

export const defaults = (): Config => ({ provider: "openai", baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.model, maxTokens: 300_000 });

const SECRETS = ["apiKey", "tavilyKey"] as const;
let fromEnv: Partial<Record<(typeof SECRETS)[number], string>> = {};

export function loadConfig(): Config {
  let c = defaults(), onDisk: Partial<Config> = {};
  try { if (existsSync(file())) onDisk = JSON.parse(readFileSync(file(), "utf8")); c = { ...c, ...onDisk }; } catch { /* corrupt config: start fresh */ }
  // keys live in the OS credential store when there is one; a key still in the file (an older version wrote it there) is moved over, and removed from the file only after it reads back
  let migrated = false;
  for (const k of SECRETS) {
    const stored = getSecret(k);
    if (stored) { c[k] = stored; if (onDisk[k]) { delete onDisk[k]; migrated = true; } }
    else if (onDisk[k] && setSecret(k, onDisk[k]!)) { delete onDisk[k]; migrated = true; }
  }
  if (migrated) writeConfigFile({ ...defaults(), ...onDisk, ...Object.fromEntries(SECRETS.map((k) => [k, undefined])) } as Config);
  // environment wins, so CI and one-off runs work without touching the saved key. It is never written back (see saveConfig).
  const claude = c.provider === "anthropic";
  fromEnv = {};
  const key = claude ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (key) c.apiKey = fromEnv.apiKey = key;
  if (process.env.TAVILY_API_KEY) c.tavilyKey = fromEnv.tavilyKey = process.env.TAVILY_API_KEY;
  if (process.env.OPENAI_BASE_URL && !claude) c.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.AMNESS_MODEL) c.model = process.env.AMNESS_MODEL;
  return c;
}

function writeConfigFile(c: Config) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(file(), JSON.stringify(c, null, 2), { mode: 0o600 }); // owner-only from the first byte
  chmodSync(file(), 0o600); // and for a file that already existed
}

export function saveConfig(c: Config) {
  const out: Config = { ...c };
  for (const k of SECRETS) {
    const v = c[k];
    if (v && v === fromEnv[k]) { delete out[k]; continue; } // this value came from an environment variable: do not store it
    if (!v) { deleteSecret(k); delete out[k]; continue; }
    if (setSecret(k, v)) delete out[k]; // stored in the OS credential store; otherwise it stays in the file (mode 600)
  }
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

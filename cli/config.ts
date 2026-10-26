import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1", needsKey: true },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", needsKey: false },
  custom: { label: "Custom OpenAI-compatible", baseUrl: "http://localhost:8000/v1", model: "my-model", needsKey: false },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export type Config = { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; tavilyKey?: string; maxTokens: number; effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; /** OpenAI wire API: auto (default) picks Responses for reasoning models and self-corrects */ api?: "auto" | "responses" | "chat" };
export const home = () => process.env.AMNESS_HOME ?? join(homedir(), ".amness");
const file = () => join(home(), "config.json");

export const defaults = (): Config => ({ provider: "openai", baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.model, maxTokens: 300_000 });

export function loadConfig(): Config {
  let c = defaults();
  try { if (existsSync(file())) c = { ...c, ...JSON.parse(readFileSync(file(), "utf8")) }; } catch { /* corrupt config: start fresh */ }
  // environment wins, so CI and one-off runs work without touching the saved file
  const claude = c.provider === "anthropic";
  const key = claude ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (key) c.apiKey = key;
  if (process.env.TAVILY_API_KEY) c.tavilyKey = process.env.TAVILY_API_KEY;
  if (process.env.OPENAI_BASE_URL && !claude) c.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.AMNESS_MODEL) c.model = process.env.AMNESS_MODEL;
  return c;
}

export function saveConfig(c: Config) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(file(), JSON.stringify(c, null, 2)); chmodSync(file(), 0o600); // may hold API keys
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

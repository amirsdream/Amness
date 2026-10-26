import type { Theme } from "./themes.ts";

/** Provider/model identity (glyph + colour) for the active theme. */
export function brandOfModel(model: string, provider: string, t: Theme): { icon: string; color: number; name: string } {
  if (/claude|fable|mythos/i.test(model) || provider === "anthropic") return { icon: "✻", color: 0xd97757, name: "Claude" };
  if (/gpt|o[134]-|openai/i.test(model) || provider === "openai") return { icon: "◈", color: 0x10a37f, name: "OpenAI" };
  if (/llama|qwen|mistral|gemma|phi|deepseek|ollama/i.test(model) || provider === "ollama") return { icon: "⬢", color: t.dim, name: "Local" };
  return { icon: "◆", color: t.info, name: "Custom" };
}

/** Pixel mascot + wordmark (plain text; colour is applied per theme). */
export const LOGO_ART = [
  "    ▗▄▄▄▄▄▄▖",
  "    █ ◖  ◗ █     ▄▀█ █▀▄▀█ █▄ █ █▀▀ █▀ █▀",
  "    ▝▀▀▀▀▀▀▘     █▀█ █ ▀ █ █ ▀█ ██▄ ▄█ ▄█",
];

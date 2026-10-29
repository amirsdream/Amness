// A small prompt registry: system prompts as versioned files, so a prompt change is something you can name, diff and test.
// `.amness/prompts/<id>.md` (and `~/.amness/prompts/`) replace the whole system prompt; the id `base` is the built-in one. `amness eval --variants full,prompt:terse` compares them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "./plugins.ts";

export type PromptDef = { id: string; text: string; file: string; scope: "project" | "user" };
const dirs = (cwd: string) => [{ dir: join(cwd, ".amness", "prompts"), scope: "project" as const }, { dir: join(process.env.AMNESS_HOME ?? join(homedir(), ".amness"), "prompts"), scope: "user" as const }];
export function loadPrompts(cwd: string): PromptDef[] {
  const seen = new Set<string>(), out: PromptDef[] = [];
  for (const { dir, scope } of dirs(cwd)) if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const id = f.replace(/\.md$/, ""); if (!/^[\w.-]{1,40}$/.test(id) || seen.has(id)) continue; seen.add(id);
    out.push({ id, text: readFileSync(join(dir, f), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(), file: join(dir, f), scope });
  }
  return out;
}
/** A plugin that swaps the system prompt for a registry prompt (the id `base` keeps the built-in one). */
export function promptPlugin(cwd: string, id: string): Plugin {
  if (id === "base") return { name: "prompt-base", description: "the built-in system prompt" };
  const p = loadPrompts(cwd).find((x) => x.id === id);
  if (!p) throw new Error(`no prompt "${id}" in .amness/prompts or ~/.amness/prompts. Found: ${loadPrompts(cwd).map((x) => x.id).join(", ") || "none"}`);
  return { name: `prompt-${id}`, description: `system prompt from ${p.file}`, system: () => p.text };
}

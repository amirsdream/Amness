// Small remembered state so the TUI stops asking things it already knows: last project, per-project verify command, task history.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { home } from "./config.ts";

export type State = { lastDir?: string; /** folders the user said they trust when Amness first opened them; a folder inside one is trusted too */ trustedDirs?: string[]; /** folders outside each project the user allowed for good: project directory -> folders (see /dirs) */ dirs?: Record<string, string[]>; verifyByDir: Record<string, string>; tasks: string[]; /** project hooks the user approved: directory -> fingerprint of the hooks.json that was approved */ hookTrust?: Record<string, string>; /** project hooks and plugins the user said no to: directory -> fingerprint of those files; not asked again until the files change (/trust asks again) */ hookDeclined?: Record<string, string>; pluginDeclined?: Record<string, string>; /** project plugins the user approved: directory -> fingerprint of the plugin files */ pluginTrust?: Record<string, string>; /** MCP servers switched off for one project: directory -> server names (/mcp disable) */ mcpDisabled?: Record<string, string[]>; /** approved MCP tool descriptions: server key -> tool -> fingerprint and text (a later change asks again) */ mcpPins?: Record<string, Record<string, { h: string; d: string }>> };
const file = () => join(home(), "state.json");

export function loadState(): State {
  try { if (existsSync(file())) return { verifyByDir: {}, tasks: [], ...JSON.parse(readFileSync(file(), "utf8")) }; } catch { /* corrupt: start fresh */ }
  return { verifyByDir: {}, tasks: [] };
}
/** Whether `dir` is a folder you trusted, or inside one. */
export const isTrustedDir = (s: State, dir: string): boolean => { const here = resolve(dir); return (s.trustedDirs ?? []).some((d) => here === d || here.startsWith(d.endsWith(sep) ? d : d + sep)); };
export function saveState(s: State) { mkdirSync(home(), { recursive: true }); writeFileSync(file(), JSON.stringify(s, null, 2)); }

/** Most-recent-first, de-duplicated, capped: the shape readline's `history` wants. */
export function rememberTask(s: State, task: string): State {
  const t = task.trim();
  return t ? { ...s, tasks: [t, ...s.tasks.filter((x) => x !== t)].slice(0, 50) } : s;
}

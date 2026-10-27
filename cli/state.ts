// Small remembered state so the TUI stops asking things it already knows: last project, per-project verify command, task history.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./config.ts";

export type State = { lastDir?: string; verifyByDir: Record<string, string>; tasks: string[]; /** project hooks the user approved: directory -> fingerprint of the hooks.json that was approved */ hookTrust?: Record<string, string> };
const file = () => join(home(), "state.json");

export function loadState(): State {
  try { if (existsSync(file())) return { verifyByDir: {}, tasks: [], ...JSON.parse(readFileSync(file(), "utf8")) }; } catch { /* corrupt: start fresh */ }
  return { verifyByDir: {}, tasks: [] };
}
export function saveState(s: State) { mkdirSync(home(), { recursive: true }); writeFileSync(file(), JSON.stringify(s, null, 2)); }

/** Most-recent-first, de-duplicated, capped: the shape readline's `history` wants. */
export function rememberTask(s: State, task: string): State {
  const t = task.trim();
  return t ? { ...s, tasks: [t, ...s.tasks.filter((x) => x !== t)].slice(0, 50) } : s;
}

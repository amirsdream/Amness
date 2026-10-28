import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { MemoryEntry, MemoryStore } from "./memory.ts";

/**
 * A portable session: provider-neutral JSON you can move to another machine, repo checkout or model.
 * It deliberately carries a handoff note + memory + the files the agent changed, not a raw transcript, because transcripts
 * are provider-specific (thinking blocks, tool-call formats) while a handoff note works anywhere.
 */
export type Bundle = {
  schema: "amness.session/1";
  createdAt: string;
  task: string;
  status: { finished: boolean; summary: string };
  handoff: string;
  memory: MemoryEntry[];
  files: Record<string, string>;
  from: { provider?: string; model?: string; cwd?: string };
};

const MAX_FILE = 200_000, MAX_TOTAL = 2_000_000;

export function collectFiles(cwd: string, paths: Iterable<string>): Record<string, string> {
  const files: Record<string, string> = {};
  let total = 0;
  for (const p of paths) {
    const abs = resolve(cwd, p);
    if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > MAX_FILE || total + statSync(abs).size > MAX_TOTAL) continue;
    const text = readFileSync(abs, "utf8");
    if (text.includes("\0")) continue; // binary
    files[normalize(p).replace(/\\/g, "/")] = text; total += text.length;
  }
  return files;
}

export const writeBundle = (path: string, b: Bundle) => { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, JSON.stringify(b, null, 2)); return path; };

export function readBundle(path: string): Bundle {
  const b = JSON.parse(readFileSync(path, "utf8"));
  if (b?.schema !== "amness.session/1" || typeof b.handoff !== "string" || typeof b.task !== "string") throw new Error(`${path} is not an Amness session bundle`);
  return b as Bundle;
}

/** Restore a bundle into `cwd`. Never overwrites a differing file unless asked; never writes outside `cwd`. */
export function applyBundle(b: Bundle, o: { cwd: string; memory?: MemoryStore; overwrite?: boolean }) {
  const root = resolve(o.cwd), restored: string[] = [], skipped: string[] = [];
  for (const [rel, content] of Object.entries(b.files)) {
    const abs = resolve(root, rel);
    if (isAbsolute(rel) || (abs !== root && !abs.startsWith(root + sep))) { skipped.push(`${rel} (outside workspace)`); continue; }
    if (existsSync(abs) && readFileSync(abs, "utf8") !== content && !o.overwrite) { skipped.push(`${rel} (differs; kept yours)`); continue; }
    mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); restored.push(rel);
  }
  let memory = 0;
  if (o.memory) for (const e of b.memory) {
    if (o.memory.list().some((x) => x.name === e.name && x.scope === e.scope)) continue;
    try { o.memory.save(e); memory++; } catch { /* skip invalid entries */ }
  }
  return { restored, skipped, memory };
}

// Conversation persistence per project, plus undo/rewind of the file changes each turn made.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Message } from "../../src/index.ts";

export type Turn = { at: number; text: string; t: number; /** path -> content before this turn's first edit (null = file did not exist) */ snaps: Record<string, string | null> };
export type SessionData = {
  id: string; created: string; updated: string; title: string; cwd: string; model: string;
  messages: Message[]; turns: Turn[]; usage: { prompt: number; completion: number; calls: number; /** prompt tokens of each request, newest last */ series?: number[]; /** prompt tokens served from the provider cache / output tokens spent reasoning */ cached?: number; reasoning?: number };
};
export type SessionInfo = { id: string; title: string; updated: string; turns: number; model: string };

export const newSession = (cwd: string, model: string): SessionData => ({
  id: new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6),
  created: new Date().toISOString(), updated: new Date().toISOString(), title: "", cwd, model, messages: [], turns: [], usage: { prompt: 0, completion: 0, calls: 0, series: [] },
});

export class SessionStore {
  dir: string;
  constructor(cwd: string) { this.dir = join(cwd, ".amness", "chats"); }
  private file(id: string) { return join(this.dir, id.replace(/[^\w-]/g, "") + ".json"); }
  save(s: SessionData) { mkdirSync(this.dir, { recursive: true }); s.updated = new Date().toISOString(); writeFileSync(this.file(s.id), JSON.stringify(s)); }
  load(id: string): SessionData | undefined { try { return JSON.parse(readFileSync(this.file(id), "utf8")); } catch { return undefined; } }
  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try { const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as SessionData; return s.turns.length ? [{ id: s.id, title: s.title, updated: s.updated, turns: s.turns.length, model: s.model }] : []; } catch { return []; }
    }).sort((a, b) => b.updated.localeCompare(a.updated));
  }
  latest() { const l = this.list()[0]; return l ? this.load(l.id) : undefined; }
  remove(id: string) { rmSync(this.file(id), { force: true }); }
}

/** Record the pre-edit content for `path` the first time this turn touches it. */
export function snapshot(turn: Turn | undefined, path: string, before: string | null | undefined) {
  if (turn && before !== undefined && !(path in turn.snaps)) turn.snaps[path] = before;
}

/**
 * Roll the conversation back to just before turn `idx`: truncate messages, drop later turns, and restore every file those turns changed
 * (the earliest snapshot wins). Never touches paths outside `cwd`.
 */
export function rewind(s: SessionData, cwd: string, idx: number): { restored: string[]; removed: string[]; skipped: string[] } {
  const root = resolve(cwd), restored: string[] = [], removed: string[] = [], skipped: string[] = [];
  const target = s.turns[idx];
  if (!target) return { restored, removed, skipped };
  const earliest = new Map<string, string | null>();
  for (const t of s.turns.slice(idx)) for (const [p, before] of Object.entries(t.snaps)) if (!earliest.has(p)) earliest.set(p, before);
  for (const [p, before] of earliest) {
    const abs = resolve(root, p);
    if (abs !== root && !abs.startsWith(root + sep)) { skipped.push(p); continue; }
    if (before === null) { if (existsSync(abs) && statSync(abs).isFile()) { rmSync(abs); removed.push(p); } }
    else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, before); restored.push(p); }
  }
  s.messages = s.messages.slice(0, target.at); s.turns = s.turns.slice(0, idx);
  return { restored, removed, skipped };
}

// Conversation persistence per project, plus undo/rewind of the file changes each turn made.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Message } from "../../src/index.ts";
import type { Snapshots } from "../../src/index.ts";

export type Turn = { /** shell commands that may have changed files this turn: a working-tree snapshot taken before the first one, and the ones undo cannot take back */ shell?: { tree?: string; cmds: string[]; irreversible: string[] }; at: number; text: string; t: number; /** path -> content before this turn's first edit (null = file did not exist) */ snaps: Record<string, string | null> };
export type SessionData = {
  /** set on a branch: the conversation it was forked from and the turn it was forked after */ parent?: { id: string; turn: number };
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

/** Like `rewind`, but first puts the working tree back to the earliest shell snapshot in the turns being undone (undoing what commands did), and reports what could not be undone. */
export async function rewindFull(s: SessionData, cwd: string, idx: number, snaps?: Snapshots): Promise<ReturnType<typeof rewind> & { tree?: { restored: string[]; removed: string[] }; irreversible: string[]; treeError?: string }> {
  const undone = s.turns.slice(idx), tree = undone.find((t) => t.shell?.tree)?.shell?.tree, irreversible = undone.flatMap((t) => t.shell?.irreversible ?? []);
  let treeResult: { restored: string[]; removed: string[] } | undefined, treeError: string | undefined;
  if (tree && snaps) { try { treeResult = await snaps.restore(tree); } catch (e) { treeError = (e as Error).message; } }
  return { ...rewind(s, cwd, idx), tree: treeResult, irreversible, treeError };
}

/** A new conversation that continues from the end of turn `idx` (0-based) of `s`. The original is untouched. */
export function forkSession(s: SessionData, idx: number): SessionData {
  const keep = s.turns.slice(0, idx + 1), end = s.turns[idx + 1]?.at ?? s.messages.length, f = newSession(s.cwd, s.model);
  return { ...f, title: (s.title || "(untitled)").replace(/ \(branch \d+\)$/, "") + ` (branch ${Math.random().toString(36).slice(2, 5)})`, messages: JSON.parse(JSON.stringify(s.messages.slice(0, end))), turns: JSON.parse(JSON.stringify(keep)), usage: { ...s.usage, series: [...(s.usage.series ?? [])] }, parent: { id: s.id, turn: idx } };
}
/** Every conversation connected to `id` by branching (its ancestors, descendants and siblings), `id` itself included. */
export function relatives(all: Pick<SessionData, "id" | "parent">[], id: string): string[] {
  const parentOf = new Map(all.map((s) => [s.id, s.parent?.id])), root = (x: string) => { const seen = new Set<string>(); while (parentOf.get(x) && !seen.has(x)) { seen.add(x); x = parentOf.get(x)!; } return x; };
  const r = root(id); return all.filter((s) => root(s.id) === r).map((s) => s.id);
}

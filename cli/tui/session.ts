// Conversation persistence per project, plus undo/rewind of the file changes each turn made.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Message } from "../../src/index.ts";
import type { Snapshots } from "../../src/index.ts";

/** One model request: its tokens, which step and agent sent it, and when. */
export type RequestUsage = { prompt: number; completion: number; cached: number; reasoning: number; /** 1 = the turn's first step, as in the loop panel */ step: number; agent?: string; at: number };
export type Turn = { /** shell commands that may have changed files this turn: a working-tree snapshot taken before the first one, and the ones undo cannot take back */ shell?: { tree?: string; cmds: string[]; irreversible: string[] }; at: number; text: string; t: number; /** path -> content before this turn's first edit (null = file did not exist) */ snaps: Record<string, string | null> };
export type SessionData = {
  /** set on a branch: the conversation it was forked from and the turn it was forked after */ parent?: { id: string; turn: number };
  id: string; created: string; updated: string; title: string; cwd: string; model: string;
  messages: Message[]; turns: Turn[]; usage: { prompt: number; completion: number; calls: number; /** prompt tokens of each request, newest last */ series?: number[]; /** each request in detail, newest last (the desktop chart shows it on hover) */ requests?: RequestUsage[]; /** prompt tokens served from the provider cache / output tokens spent reasoning */ cached?: number; reasoning?: number };
};
export type SessionInfo = { id: string; title: string; updated: string; turns: number; model: string };

/** The last few exchanges of a conversation as short lines, for a preview. */
export function previewLines(s: Pick<SessionData, "messages">, n = 6): string[] {
  const said = s.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim() && !m.content.startsWith("<"))
    .map((m) => `${m.role === "user" ? "you" : "amness"}  ${m.content!.split("\n\n<attached>")[0].replace(/\s+/g, " ").trim()}`);
  return said.slice(-n);
}

export const newSession = (cwd: string, model: string): SessionData => ({
  id: new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6),
  created: new Date().toISOString(), updated: new Date().toISOString(), title: "", cwd, model, messages: [], turns: [], usage: { prompt: 0, completion: 0, calls: 0, series: [] },
});

const contentHash = (s: SessionData) => createHash("sha1").update(JSON.stringify([s.messages, s.turns])).digest("hex");

/** Write a file in one step: a crash leaves the old file or the new one, never half of one. */
function writeAtomic(file: string, text: string) { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); }

/** One line of a conversation file. The first is a whole snapshot; later ones only say what changed (append-only, like Claude Code's transcripts). */
type Line =
  | { k: "head"; s: Omit<SessionData, "messages" | "turns">; messages: Message[]; turns: Turn[] }
  | { k: "meta"; set: Partial<Omit<SessionData, "messages" | "turns">> }
  | { k: "msg"; m: Message } | { k: "cut"; messages: number }
  | { k: "turn"; t: Turn } | { k: "cutTurns"; turns: number };
/** What was last written for a conversation, so the next save appends only the difference. */
type Written = { msgs: string[]; turns: string[]; meta: Record<string, string>; bytes: number; snap: number };
const metaOf = (s: SessionData): Record<string, string> => { const { messages: _m, turns: _t, ...rest } = s; void _m; void _t; return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, JSON.stringify(v)])); };
const infoOf = (s: SessionData): SessionInfo => ({ id: s.id, title: s.title, updated: s.updated, turns: s.turns.length, model: s.model });

/** Replay a conversation file. A line that does not parse (a crash cut the last one short) ends the replay: everything before it is kept. */
export function replay(text: string): SessionData | undefined {
  let s: SessionData | undefined;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let l: Line; try { l = JSON.parse(raw); } catch { break; }
    if (l.k === "head") s = { ...(l.s as SessionData), messages: l.messages, turns: l.turns };
    else if (!s) return undefined;
    else if (l.k === "meta") Object.assign(s, l.set);
    else if (l.k === "msg") s.messages.push(l.m);
    else if (l.k === "cut") s.messages.length = Math.min(s.messages.length, l.messages);
    else if (l.k === "turn") s.turns.push(l.t);
    else if (l.k === "cutTurns") s.turns.length = Math.min(s.turns.length, l.turns);
  }
  return s;
}

/**
 * Conversations of one project, in `.amness/chats/<id>.jsonl`. A save appends what changed since the last one (new messages, a cut after a
 * rewind or a compaction, new turns, changed details), so a crash in the middle of a save loses at most that save, never the conversation.
 * When the appended lines outgrow the snapshot, the file is written again as one snapshot (atomically). `index.json` keeps the list's
 * details, checked against each file's time and size, so listing does not read every conversation. Older `<id>.json` files still load
 * and become `.jsonl` at their next save.
 */
export class SessionStore {
  dir: string;
  constructor(cwd: string) { this.dir = join(cwd, ".amness", "chats"); }
  private safe(id: string) { return id.replace(/[^\w-]/g, ""); }
  private file(id: string) { return join(this.dir, this.safe(id) + ".jsonl"); }
  private legacy(id: string) { return join(this.dir, this.safe(id) + ".json"); }
  /** A hash of each conversation's content as last loaded or saved, so a save that changed nothing keeps its place in the list. */
  private seen = new Map<string, string>();
  private written = new Map<string, Written>();
  /** Save `s`. Its time (`updated`, which orders the conversation list) moves only when its messages or turns changed: opening another conversation, renaming or a settings change saves too, and must not move it to the top. */
  save(s: SessionData) {
    mkdirSync(this.dir, { recursive: true });
    const h = contentHash(s); if (this.seen.get(s.id) !== h) s.updated = new Date().toISOString();
    this.seen.set(s.id, h);
    const file = this.file(s.id), w = this.written.get(s.id), msgs = s.messages.map((m) => JSON.stringify(m)), turns = s.turns.map((t) => JSON.stringify(t)), meta = metaOf(s);
    if (!w || !existsSync(file) || w.bytes > Math.max(256 << 10, w.snap)) { this.snapshot(s, msgs, turns, meta); return; }
    const out: string[] = [], same = (a: string[], b: string[]) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
    const pm = same(w.msgs, msgs); if (pm < w.msgs.length) out.push(JSON.stringify({ k: "cut", messages: pm })); for (const m of msgs.slice(pm)) out.push(`{"k":"msg","m":${m}}`);
    const pt = same(w.turns, turns); if (pt < w.turns.length) out.push(JSON.stringify({ k: "cutTurns", turns: pt })); for (const t of turns.slice(pt)) out.push(`{"k":"turn","t":${t}}`);
    const set: Record<string, unknown> = {}; for (const [k, v] of Object.entries(meta)) if (w.meta[k] !== v) set[k] = JSON.parse(v);
    if (Object.keys(set).length) out.push(JSON.stringify({ k: "meta", set }));
    if (!out.length) return;
    const text = out.join("\n") + "\n"; appendFileSync(file, text);
    this.written.set(s.id, { msgs, turns, meta, bytes: w.bytes + text.length, snap: w.snap });
    this.indexPut(s);
  }
  /** Write the whole conversation as one snapshot line, replacing the file in one step. */
  private snapshot(s: SessionData, msgs: string[], turns: string[], meta: Record<string, string>) {
    const { messages: _m, turns: _t, ...head } = s; void _m; void _t;
    const text = `{"k":"head","s":${JSON.stringify(head)},"messages":[${msgs.join(",")}],"turns":[${turns.join(",")}]}\n`;
    writeAtomic(this.file(s.id), text); rmSync(this.legacy(s.id), { force: true });
    this.written.set(s.id, { msgs, turns, meta, bytes: 0, snap: text.length });
    this.indexPut(s);
  }
  load(id: string): SessionData | undefined {
    let s: SessionData | undefined;
    try { s = replay(readFileSync(this.file(id), "utf8")); } catch { try { s = JSON.parse(readFileSync(this.legacy(id), "utf8")) as SessionData; } catch { return undefined; } }
    if (!s) return undefined;
    this.seen.set(s.id, contentHash(s)); this.written.delete(s.id);        // the next save writes a fresh snapshot: the file may have been written by another window
    return s;
  }
  // ---------------------------------------------------------------- the list, from an index checked against the files
  private indexFile() { return join(this.dir, "index.json"); }
  private index(): Record<string, SessionInfo & { mtime: number; size: number; file: string }> { try { return JSON.parse(readFileSync(this.indexFile(), "utf8")).items ?? {}; } catch { return {}; } }
  private indexPut(s: SessionData) {
    try { const ix = this.index(), f = this.file(s.id), st = statSync(f); ix[s.id] = { ...infoOf(s), mtime: st.mtimeMs, size: st.size, file: basename(f) }; writeAtomic(this.indexFile(), JSON.stringify({ v: 1, items: ix })); } catch { /* the index is only a cache */ }
  }
  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return [];
    const ix = this.index(), out: SessionInfo[] = [], fresh: typeof ix = {};
    let changed = false;
    const names = readdirSync(this.dir), jsonl = new Set(names.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)));
    for (const f of names) {
      const isNew = f.endsWith(".jsonl"), isOld = f.endsWith(".json") && f !== "index.json" && !jsonl.has(f.slice(0, -5));
      if (!isNew && !isOld) continue;
      const p = join(this.dir, f); let st; try { st = statSync(p); } catch { continue; }
      const id = f.replace(/\.jsonl?$/, ""), hit = ix[id];
      let info: SessionInfo | undefined;
      if (hit && hit.file === f && hit.mtime === st.mtimeMs && hit.size === st.size) info = hit;
      else { changed = true; try { const s = isNew ? replay(readFileSync(p, "utf8")) : (JSON.parse(readFileSync(p, "utf8")) as SessionData); if (s) info = infoOf(s); } catch { /* unreadable: left out */ } }
      if (!info) continue;
      fresh[id] = { ...info, mtime: st.mtimeMs, size: st.size, file: f };
      if (info.turns) out.push({ id: info.id, title: info.title, updated: info.updated, turns: info.turns, model: info.model });
    }
    if (changed || Object.keys(fresh).length !== Object.keys(ix).length) try { writeAtomic(this.indexFile(), JSON.stringify({ v: 1, items: fresh })); } catch { /* read-only folder */ }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }
  /** A conversation by its name: the exact title first (any case), else the only one whose title contains `q`. */
  find(q: string): SessionData | undefined {
    const l = this.list(), n = q.trim().toLowerCase(); if (!n) return undefined;
    const hit = l.find((s) => s.title.toLowerCase() === n) ?? (() => { const m = l.filter((s) => s.title.toLowerCase().includes(n)); return m.length === 1 ? m[0] : undefined; })();
    return hit ? this.load(hit.id) : undefined;
  }
  latest() { const l = this.list()[0]; return l ? this.load(l.id) : undefined; }
  remove(id: string) { rmSync(this.file(id), { force: true }); rmSync(this.legacy(id), { force: true }); this.written.delete(id); this.seen.delete(id); }
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
  return { ...f, title: (s.title || "(untitled)").replace(/ \(branch \d+\)$/, "") + ` (branch ${Math.random().toString(36).slice(2, 5)})`, messages: JSON.parse(JSON.stringify(s.messages.slice(0, end))), turns: JSON.parse(JSON.stringify(keep)), usage: { ...s.usage, series: [...(s.usage.series ?? [])], requests: [...(s.usage.requests ?? [])] }, parent: { id: s.id, turn: idx } };
}
/** Every conversation connected to `id` by branching (its ancestors, descendants and siblings), `id` itself included. */
export function relatives(all: Pick<SessionData, "id" | "parent">[], id: string): string[] {
  const parentOf = new Map(all.map((s) => [s.id, s.parent?.id])), root = (x: string) => { const seen = new Set<string>(); while (parentOf.get(x) && !seen.has(x)) { seen.add(x); x = parentOf.get(x)!; } return x; };
  const r = root(id); return all.filter((s) => root(s.id) === r).map((s) => s.id);
}

// Caches the harness keeps for itself, whatever the provider: a tool-result cache with a "same as before" pointer, so a repeated read costs a line, not a file.
// A cached result is only reused while nothing it could depend on has changed: no edit or state-changing tool has run since, the tool's own stamp (for a file: its size and mtime) is the same, and it is not older than the TTL.
// The pointer is only sent while the earlier output is still word for word in the conversation; once that output is shortened, the pointer is shortened with it (`repairPointers`), so it never points at nothing.
import type { Message } from "./harness.ts";

const POINTER = /^\[unchanged since call (\S+):/;
export const isPointer = (m: Message): boolean => m.role === "tool" && POINTER.test(m.content ?? "");
export const pointerText = (callId: string) => `[unchanged since call ${callId}: same result as that call, which is still above in this conversation]`;

type Entry = { world: number; at: number; stamp: string; result: string; callId: string };
export class ToolCache {
  hits = 0; pointers = 0; misses = 0; /** characters the model did not have to receive again */ saved = 0;
  private m = new Map<string, Entry>(); private ttl: number;
  constructor(ttl = 20_000) { this.ttl = ttl; }
  /** A stored result that is still valid, or undefined. */
  get(key: string, world: number, stamp: string, now = Date.now()): Entry | undefined {
    const e = this.m.get(key);
    if (e && e.world === world && e.stamp === stamp && now - e.at <= this.ttl) return e;
    if (e) this.m.delete(key);
    return undefined;
  }
  drop(key: string) { this.m.delete(key); }
  set(key: string, e: Omit<Entry, "at">, now = Date.now()) { this.m.set(key, { ...e, at: now }); if (this.m.size > 200) this.m.delete(this.m.keys().next().value!); }
  clear() { this.m.clear(); }
  stats() { return { hits: this.hits, pointers: this.pointers, misses: this.misses, saved: this.saved }; }
}

/** True while the output of `callId` is still in the conversation word for word (not elided, superseded or stale). */
export const stillAbove = (msgs: Message[], callId: string): boolean => msgs.some((m) => m.role === "tool" && m.tool_call_id === callId && !!m.content && !m.content.startsWith("["));

/** A pointer whose original was shortened since is shortened too. Returns how many it rewrote. */
export function repairPointers(msgs: Message[]): number {
  let n = 0;
  for (const m of msgs) {
    if (!isPointer(m)) continue;
    const id = POINTER.exec(m.content!)![1];
    if (!stillAbove(msgs, id)) { m.content = "[old output elided; call the tool again if you need it]"; n++; }
  }
  return n;
}

// Read overlap. A model often reads a file in pieces (lines 1-120, then 90-220, then the whole file), so about 30% of the text of file reads is lines it was already given
// (measured on 632 recorded reads, file unedited in between). `ReadLedger` remembers which line numbers were delivered, and by which call. A later read of the same unchanged file gets only the
// new lines; each run of lines already above is replaced by one marker line. The marker names the call that holds those lines, and `repairMarkers` rewrites it if that output is shortened later.
const MARKER = /^\(lines (\d+)-(\d+) unchanged: already above in the output of call (\S+)\)$/;
/** The call a read marker points at (global: use with matchAll). */
export const MARKER_REF = /^\(lines \d+-\d+ unchanged: already above in the output of call (\S+)\)$/gm;
const NUMBERED = /^(\d+)\t/;
export class ReadLedger {
  /** characters the model did not have to receive again */ saved = 0;
  private files = new Map<string, { stamp: string; lines: Map<number, string> }>();
  /**
   * `result` is a numbered file read (`N<TAB>text` per line). Returns it with runs of at least `minRun` already-delivered lines replaced by a marker, and records what this result now delivers.
   * With `record` false nothing is recorded: the caller shortens the result further (condensing) and then records what was really sent with `record()`.
   */
  dedupe(path: string, stamp: string, result: string, callId: string, isAbove: (callId: string) => boolean, minRun = 6, record = true): string {
    const seen = new Map<string, boolean>(), above = (id: string) => { let v = seen.get(id); if (v === undefined) { v = isAbove(id); seen.set(id, v); } return v; };   // one transcript scan per call id, not per line
    let f = this.files.get(path); if (!f || f.stamp !== stamp) { f = { stamp, lines: new Map() }; this.files.set(path, f); }
    const rows = result.split("\n"), out: string[] = [], delivered: number[] = [];
    for (let i = 0; i < rows.length; ) {
      const n = NUMBERED.exec(rows[i]) ? Number(NUMBERED.exec(rows[i])![1]) : undefined, prior = n === undefined ? undefined : f.lines.get(n);
      if (n === undefined || !prior || !above(prior)) { out.push(rows[i]); if (n !== undefined) delivered.push(n); i++; continue; }
      let j = i + 1;                                                                                  // extend the run while the next line is the next number and also delivered earlier
      while (j < rows.length) { const m = NUMBERED.exec(rows[j]); const p = m ? f.lines.get(Number(m[1])) : undefined; if (!m || Number(m[1]) !== n + (j - i) || p !== prior) break; j++; }      // one marker, one source call
      if (j - i >= minRun) { out.push(`(lines ${n}-${n + (j - i) - 1} unchanged: already above in the output of call ${prior})`); this.saved += rows.slice(i, j).join("\n").length - out[out.length - 1].length; i = j; }
      else { for (let k = i; k < j; k++) { out.push(rows[k]); delivered.push(n + (k - i)); } i = j; }                                // too short to be worth a marker: send the lines again
    }
    if (record) for (const n of delivered) f.lines.set(n, callId);
    return out.join("\n");
  }
  /** Record the numbered lines that `sent` (the text the model got) delivers. */
  record(path: string, stamp: string, sent: string, callId: string): void {
    let f = this.files.get(path); if (!f || f.stamp !== stamp) { f = { stamp, lines: new Map() }; this.files.set(path, f); }
    for (const row of sent.split("\n")) { const m = NUMBERED.exec(row); if (m) f.lines.set(Number(m[1]), callId); }
  }
}

/** A marker whose source output was shortened since says so instead of pointing at nothing. Returns how many it rewrote. */
export function repairMarkers(msgs: Message[]): number {
  let n = 0;
  for (const m of msgs) {
    if (m.role !== "tool" || !m.content?.includes("(lines ")) continue;
    const next = m.content.split("\n").map((row) => { const k = MARKER.exec(row); return k && !stillAbove(msgs, k[3]) ? `(lines ${k[1]}-${k[2]}: the earlier output was shortened; read them again if you need them)` : row; });
    const joined = next.join("\n"); if (joined !== m.content) { m.content = joined; n++; }
  }
  return n;
}

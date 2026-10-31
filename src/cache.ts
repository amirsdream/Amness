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

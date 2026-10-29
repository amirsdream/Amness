// The retained transcript: structured blocks (not pre-rendered text), so the full-screen UI can re-wrap on resize,
// collapse/expand tool output, hit-test clicks, search, and rebuild itself from a saved conversation.
import type { Message } from "../../src/index.ts";
import { unifiedDiff } from "../../src/diff.ts";

export type Edit = { path: string; created: boolean; added: number; removed: number; diff: string };
export type Block =
  | { id: number; kind: "user"; text: string; note?: string; queued?: boolean }
  | { id: number; kind: "assistant"; text: string; streaming: boolean }
  | { id: number; kind: "tool"; callId: string; name: string; args: string; status: "running" | "ok" | "fail"; result?: string; edit?: Edit; agent?: string; t0: number; ms?: number; expanded?: boolean; /** show every diff row, not just the first screenful */ more?: boolean }
  | { id: number; kind: "thinking"; text: string; active: boolean; t0: number; ms?: number; expanded?: boolean }
  | { id: number; kind: "notice"; level: "info" | "warn" | "error" | "ok"; text: string }
  | { id: number; kind: "summary"; text: string }
  | { id: number; kind: "raw"; lines: string[] };
export type BlockKind = Block["kind"];

const failed = (r: string) => /^(ERROR|DENIED|REJECTED)/.test(r) || /^stopped: (interrupted|no progress|no measurable)/.test(r) || /^exit=(?!0\b)/.test(r);

export class BlockStore {
  blocks: Block[] = [];
  version = 0;
  private n = 0;
  private openAssistant?: number; private openThinking?: number;

  private add<T extends Block>(b: Omit<T, "id">): T { const blk = { ...b, id: ++this.n } as T; this.blocks.push(blk); this.version++; return blk; }
  get(id: number) { return this.blocks.find((b) => b.id === id); }
  private last<K extends BlockKind>(kind: K, open?: number) { return open === undefined ? undefined : (this.blocks.find((b) => b.id === open && b.kind === kind) as Extract<Block, { kind: K }> | undefined); }

  clear() { this.blocks = []; this.openAssistant = this.openThinking = undefined; this.version++; }
  addUser(text: string, note?: string, queued?: boolean) { this.endAssistant(); return this.add<Extract<Block, { kind: "user" }>>({ kind: "user", text, note, queued }); }
  /** Append streamed assistant text (starts a new block if none is open). */
  streamAssistant(delta: string) {
    this.endThinking();
    let b = this.last("assistant", this.openAssistant);
    if (!b) { b = this.add<Extract<Block, { kind: "assistant" }>>({ kind: "assistant", text: "", streaming: true }); this.openAssistant = b.id; }
    b.text += delta; this.version++;
  }
  /** The model's complete message (used when nothing was streamed). */
  setAssistant(text: string) { if (!this.last("assistant", this.openAssistant)) this.streamAssistant(text); }
  endAssistant() { const b = this.last("assistant", this.openAssistant); if (b) { b.streaming = false; this.version++; } this.openAssistant = undefined; }
  streamThinking(delta: string) {
    let b = this.last("thinking", this.openThinking);
    if (!b) { b = this.add<Extract<Block, { kind: "thinking" }>>({ kind: "thinking", text: "", active: true, t0: Date.now() }); this.openThinking = b.id; }
    b.text += delta; this.version++;
  }
  endThinking() { const b = this.last("thinking", this.openThinking); if (b) { b.active = false; b.ms = Date.now() - b.t0; this.version++; } this.openThinking = undefined; }
  toolStart(id: string, name: string, args: string, agent?: string) { this.endAssistant(); this.endThinking(); return this.add<Extract<Block, { kind: "tool" }>>({ kind: "tool", callId: id, name, args, status: "running", agent, t0: Date.now() }); }
  tool(callId: string) { return [...this.blocks].reverse().find((b) => b.kind === "tool" && b.callId === callId) as Extract<Block, { kind: "tool" }> | undefined; }
  toolEnd(callId: string, result: string, edit?: Edit) {
    const b = this.tool(callId);
    if (!b) return; b.result = result; b.status = failed(result) ? "fail" : "ok"; b.ms = Date.now() - b.t0; if (edit) b.edit = edit; this.version++;
  }
  /** A turn has ended (finished, interrupted or failed): any tool card still "running" can never complete, so close it instead of leaving a spinner on screen. */
  closeRunning(note = "interrupted") {
    let n = 0; for (const b of this.blocks) if (b.kind === "tool" && b.status === "running") { b.status = "fail"; b.result = b.result ?? `(${note})`; b.ms = Date.now() - b.t0; n++; }
    if (n) this.version++; return n;
  }
  notice(level: "info" | "warn" | "error" | "ok", text: string) { this.endAssistant(); return this.add<Extract<Block, { kind: "notice" }>>({ kind: "notice", level, text }); }
  summary(text: string) { this.endAssistant(); return this.add<Extract<Block, { kind: "summary" }>>({ kind: "summary", text }); }
  raw(lines: string[]) { return this.add<Extract<Block, { kind: "raw" }>>({ kind: "raw", lines }); }
  toggle(id: number) { const b = this.get(id); if (b && (b.kind === "tool" || b.kind === "thinking")) { if (b.kind === "tool") b.more = false; b.expanded = !(b.expanded ?? (b.kind === "tool" && !!(b.edit || b.status === "fail"))); this.version++; } }
  /** Every user message with its block index (for sticky headers and prompt jumping). */
  prompts() { return this.blocks.flatMap((b, i) => (b.kind === "user" ? [{ block: b, index: i }] : [])); }

  /** Rebuild from a saved conversation (resume, undo, compact). Tool results are matched to their calls; edit diffs are reconstructed from the call arguments. */
  loadMessages(messages: Message[]) {
    this.clear();
    const results = new Map<string, string>();
    for (const m of messages) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content ?? "");
    for (const m of messages) {
      if (m.role === "user") { const t = (m.content ?? "").split("\n\n<attached>")[0].split("\n\n## ")[0].replace(/^\[mode:[^\]]*\]\n\n/, ""); if (t.trim()) this.addUser(t); }
      else if (m.role === "assistant") {
        if (m.content?.trim()) { this.streamAssistant(m.content); this.endAssistant(); }
        for (const c of m.tool_calls ?? []) {
          if (c.function.name === "finish") continue;
          const b = this.toolStart(c.id, c.function.name, c.function.arguments), res = results.get(c.id);
          let edit: Edit | undefined;
          try {
            const a = JSON.parse(c.function.arguments);
            if (c.function.name === "edit_file" && a.old !== undefined) edit = { path: a.path, created: false, ...(({ added, removed, diff }) => ({ added, removed, diff }))(unifiedDiff(a.path, a.old, a.new ?? "")) };
            else if (c.function.name === "write_file") edit = { path: a.path, created: true, ...(({ added, removed, diff }) => ({ added, removed, diff }))(unifiedDiff(a.path, null, a.content ?? "")) };
          } catch { /* unparsable arguments: show the call without a diff */ }
          if (res !== undefined) { this.toolEnd(c.id, res, res && !failed(res) ? edit : undefined); b.ms = undefined; } else { b.status = "ok"; }
        }
      }
    }
  }
}

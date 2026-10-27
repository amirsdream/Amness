// Tracing: every loop event goes to a local JSONL file (always, cheap, greppable) and optionally to an OpenTelemetry collector (OTLP/HTTP JSON, plain fetch).
// The JSONL file is also what `replay` and failure mining read, so it keeps what is needed to re-run the harness logic: the model's messages and tool results.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Event } from "./harness.ts";
import { redactDeep } from "./secrets.ts";

export type TraceLine = { t: string; ms: number; kind: string; [k: string]: unknown };
export type TracerOptions = { /** receive every line as it is written (used by replay) */ sink?: (line: TraceLine) => void; file?: string; otlp?: string; sessionId: string; model?: string; /** extra resource attributes */ attrs?: Record<string, string> };

const clip = (s: unknown, n: number) => { const t = typeof s === "string" ? s : JSON.stringify(s) ?? ""; return t.length > n ? t.slice(0, n) + `…[${t.length - n} more]` : t; };
type Span = { name: string; spanId: string; parent?: string; start: number; end: number; attrs: Record<string, string | number | boolean>; error?: string };
const hex = (n: number) => randomBytes(n).toString("hex");
const ns = (ms: number) => String(Math.round(ms * 1e6));
const attrVal = (v: string | number | boolean) => (typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v });

export class Tracer {
  readonly file?: string; private sink?: (l: TraceLine) => void; private otlp?: string; private id: string; private model?: string; private attrs: Record<string, string>;
  private t0 = Date.now(); private traceId = hex(16); private rootId = hex(8);
  private spans: Span[] = []; private open = new Map<string, Span>(); private turnStart = 0; private textChars = 0; private pending: Promise<unknown>[] = [];
  /** Rolling data for the cache-waste figure. */
  turns: { prompt: number; cached: number; break?: boolean }[] = [];
  constructor(o: TracerOptions) { this.file = o.file; this.sink = o.sink; this.otlp = o.otlp; this.id = o.sessionId; this.model = o.model; this.attrs = o.attrs ?? {}; if (o.file) { try { mkdirSync(dirname(o.file), { recursive: true }); } catch { /* writes below will fail quietly */ } } }

  private agent?: string;
  private write(kind: string, rest: Record<string, unknown>) {
    if (!this.file && !this.sink) return;
    const line: TraceLine = { t: new Date().toISOString(), ms: Date.now() - this.t0, kind, ...(this.agent && { agent: this.agent }), ...redactDeep(rest) };       // secrets never reach the trace file
    this.sink?.(line); if (!this.file) return;
    try { appendFileSync(this.file, JSON.stringify(line) + "\n"); } catch { /* a full disk must not stop the agent */ }
  }
  /** Record the messages the model produced (needed for replay). */
  message(m: { role: string; content: string | null; tool_calls?: unknown }) { this.write("message", { role: m.role, content: clip(m.content ?? "", 20_000), tool_calls: m.tool_calls }); }

  event(e: Event & { agent?: string }) {
    const now = Date.now(); this.agent = e.agent && e.agent !== "lead" ? e.agent : undefined;
    switch (e.kind) {
      case "text": case "thinking": this.textChars += e.delta.length; return;                                   // too chatty; the finished message is recorded instead
      case "run": this.write("run", { messages: e.messages.map((m) => ({ ...m, content: clip(m.content ?? "", 60_000) })) }); return;
      case "model": this.write("model", { message: { ...e.message, content: clip(e.message.content ?? "", 60_000) } }); return;
      case "assistant": this.write("assistant", { chars: e.text.length, streamed: e.streamed }); this.textChars = 0; return;
      case "phase": if (e.phase === "model") this.turnStart = now; this.write("phase", { phase: e.phase, step: e.step, n: e.n }); return;
      case "turn": {
        this.turns.push({ prompt: e.prompt, cached: e.cached });
        this.write("turn", { step: e.step, prompt: e.prompt, completion: e.completion, cached: e.cached, reasoning: e.reasoning, ms: now - (this.turnStart || now) });
        this.add({ name: `chat ${this.model ?? ""}`.trim(), start: this.turnStart || now, end: now, attrs: { "gen_ai.operation.name": "chat", ...(this.model && { "gen_ai.request.model": this.model }), "gen_ai.usage.input_tokens": e.prompt, "gen_ai.usage.output_tokens": e.completion, "gen_ai.usage.cache_read.input_tokens": e.cached, "amness.step": e.step } });
        return;
      }
      case "toolstart": { const s: Span = { name: `execute_tool ${e.name}`, spanId: hex(8), start: now, end: now, attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": e.name } }; this.open.set(e.id, s); this.write("toolstart", { id: e.id, name: e.name, args: clip(e.args, 20_000) }); return; }
      case "tool": {
        const s = this.open.get(e.id ?? ""); this.open.delete(e.id ?? "");
        const failed = /^(ERROR|DENIED|REJECTED|BLOCKED)/.test(e.result);
        this.write("tool", { id: e.id, name: e.name, ms: s ? now - s.start : undefined, ok: !failed, result: clip(e.result, 100_000) });
        if (s) { s.end = now; s.attrs["amness.tool.ok"] = !failed; if (failed) s.error = clip(e.result, 200); this.add(s); }
        return;
      }
      case "cachebreak": { const last = this.turns.at(-1); if (last) last.break = true; this.write("cachebreak", { reason: e.reason, at: e.at }); return; }
      case "hook": this.write("hook", { event: e.event, detail: clip(e.detail, 500), blocked: e.blocked }); this.add({ name: `hook ${e.event}`, start: now, end: now, attrs: { "amness.hook.event": e.event, "amness.hook.blocked": e.blocked } }); return;
      case "edit": this.write("edit", { path: e.path, created: e.created, added: e.added, removed: e.removed }); return;
      default: { const d = e as { detail?: string; summary?: string; text?: string; saved?: number; what?: string; todos?: unknown }; this.write(e.kind, { detail: clip(d.detail ?? d.summary ?? d.text ?? (d.saved !== undefined ? `${d.saved} chars: ${d.what}` : ""), 1000) }); }
    }
  }

  private add(s: Omit<Span, "spanId" | "parent"> & { spanId?: string }) {
    if (!this.otlp) return;
    this.spans.push({ ...s, spanId: s.spanId ?? hex(8), parent: this.rootId }); if (this.spans.length >= 50) this.flush();
  }
  /** OTLP/HTTP JSON body for the spans collected so far. */
  payload(): object {
    const root: Span = { name: "amness session", spanId: this.rootId, start: this.t0, end: Date.now(), attrs: { "amness.session.id": this.id } };
    const all = [root, ...this.spans];
    return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "amness" } }, ...Object.entries(this.attrs).map(([k, v]) => ({ key: k, value: { stringValue: v } }))] },
      scopeSpans: [{ scope: { name: "amness" }, spans: all.map((s) => ({ traceId: this.traceId, spanId: s.spanId, ...(s.parent && { parentSpanId: s.parent }), name: s.name, kind: 1, startTimeUnixNano: ns(s.start), endTimeUnixNano: ns(Math.max(s.end, s.start)),
        attributes: Object.entries(s.attrs).map(([key, v]) => ({ key, value: attrVal(v) })), ...(s.error && { status: { code: 2, message: s.error } }) })) }] }] };
  }
  flush() {
    if (!this.otlp || !this.spans.length) return;
    const body = JSON.stringify(this.payload()); this.spans = [];
    this.pending.push(fetch(this.otlp.replace(/\/$/, "").replace(/\/v1\/traces$/, "") + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {}));
  }
  async close() { this.write("end", {}); this.flush(); await Promise.allSettled(this.pending); }
}

/**
 * Prompt tokens that were re-read at full price although the prefix should have been cached: for each turn, the uncached part beyond what was newly added since the
 * previous turn. A fresh start (first turn) and the turns right after a deliberate rewrite are not waste, so only turns where the cache really should have hit count.
 */
export function cacheWaste(turns: { prompt: number; cached: number; break?: boolean }[]): number {
  let waste = 0;
  for (let i = 1; i < turns.length; i++) { const grew = Math.max(0, turns[i].prompt - turns[i - 1].prompt), uncached = Math.max(0, turns[i].prompt - turns[i].cached); waste += Math.max(0, uncached - grew); }
  return waste;
}

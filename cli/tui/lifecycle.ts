// The lifecycle model behind the Advanced view: a session's trace lines (the file, or live lines as they are written) turned into chats, steps and frames,
// each frame placed on one box of the loop diagram. Both front ends draw from this, so the terminal and the desktop show the same thing.
// The model is pure data: no drawing, no App. Details of a frame (the exact request, a diff, a hook's input) are built only when asked for (`detailOf`).
import { readRequests, type TraceLine } from "../../src/index.ts";

/** The boxes of the diagram, in loop order. */
export type Box = "you" | "hooks" | "context" | "model" | "tools" | "guards" | "finish" | "answer";
export const BOXES: { id: Box; label: string; glyph: string; help: string }[] = [
  { id: "you", label: "You", glyph: "❯", help: "your message, and anything you changed while paused" },
  { id: "hooks", label: "Hooks", glyph: "⚙", help: "your hook commands: what each got, did and returned" },
  { id: "context", label: "Context", glyph: "◫", help: "what is sent: trimming, compaction, handoffs, the tool list, cache breaks" },
  { id: "model", label: "Model", glyph: "◆", help: "the exact request, the thinking, the reply and its tokens" },
  { id: "tools", label: "Tools", glyph: "⚒", help: "each call: arguments, policy, approval, result, diff" },
  { id: "guards", label: "Guards", glyph: "⛨", help: "the harness stepping in: loops, nudges, budget, repairs, ladder" },
  { id: "finish", label: "Finish", glyph: "✓", help: "the finish gate: ledger, checks, verify, reviewer, Stop hooks" },
  { id: "answer", label: "Answer", glyph: "✔", help: "the result, or why the run stopped" },
];
export const boxLabel = (b: Box) => BOXES.find((x) => x.id === b)!.label;
/** Boxes a run can be paused at, and the pause points inside each. */
export const PAUSABLE: Partial<Record<Box, string>> = { model: "before each model call and after its reply", tools: "before and after each tool call", finish: "when the model calls finish" };
export const boxOfPause = (at: string): Box => (at === "model" || at === "reply" ? "model" : at === "tool" || at === "result" ? "tools" : "finish");

export type Tone = "plain" | "ok" | "warn" | "err" | "you";
export type Frame = {
  /** index of the trace line */ line: number; t: string; ms: number; box: Box; kind: string;
  title: string; summary: string; tone: Tone;
  /** chat number (1-based; 0 = before any chat) and loop step (1-based; 0 = outside a step) */ chat: number; step: number;
  /** a subagent's frames carry its name */ agent?: string;
};
export type Chat = { n: number; title: string; first: number; last: number };
export type Section = { title: string; body: string; kind?: "text" | "json" | "diff" | "md" };

const one = (s: unknown, n = 120) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const tok = (n: unknown) => { const v = Number(n) || 0; return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(v); };
const dur = (ms: unknown) => { const v = Number(ms) || 0; return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`; };
const argLine = (args: unknown) => { let a: any = args; if (typeof a === "string") { try { a = JSON.parse(a); } catch { return one(a, 90); } } if (!a || typeof a !== "object") return ""; const v = a.cmd ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.name ?? a.task ?? Object.values(a)[0]; return one(v, 90); };
const bad = (r: unknown) => /^(ERROR|DENIED|REJECTED|BLOCKED|REFUSED|SKIPPED)/.test(String(r ?? ""));

/** Where each kind of trace line goes, and how it reads in one line. Undefined = not shown (bookkeeping lines). Every harness event kind has an entry (a test checks). */
export const KIND: Record<string, ((l: TraceLine) => Pick<Frame, "box" | "title" | "summary" | "tone">) | null> = {
  chat: (l) => ({ box: "you", title: "Your message", summary: one(l.text), tone: "you" }),
  run: (l) => { const ms = (l.messages as { role: string; content?: string }[] | undefined) ?? [], u = [...ms].reverse().find((m) => m.role === "user"); return { box: "you", title: "Run starts", summary: `${ms.length} messages${u ? ` · last: ${one(u.content, 80)}` : ""}`, tone: "you" }; },
  steer: (l) => ({ box: "you", title: "You steered", summary: one(l.text ?? l.detail), tone: "you" }),
  override: (l) => ({ box: boxOfPause(String(l.at)), title: "You changed", summary: one(l.detail), tone: "you" }),
  hookrun: (l) => { const runs = (l.runs as { outcome: string; ms: number }[] | undefined) ?? [], r = (l.result ?? {}) as { block?: string }; return { box: "hooks", title: `${l.event} hooks`, summary: runs.length ? runs.map((x) => `${x.outcome} ${dur(x.ms)}`).join(" · ") : "ran", tone: r.block ? "warn" : "plain" }; },
  hook: (l) => { const ev = String(l.event); const box: Box = ev === "Advisor" ? "guards" : ev === "Ledger" ? "finish" : ev === "Redact" ? "tools" : ev === "Window" ? "context" : "hooks"; return { box, title: box === "hooks" ? `${ev} hook${l.blocked ? " blocked" : ""}` : ev, summary: one(l.detail), tone: l.blocked ? "warn" : "plain" }; },
  trim: (l) => ({ box: "context", title: "Trimmed", summary: one(l.detail ?? `${l.saved} chars: ${l.what}`), tone: "plain" }),
  cachebreak: (l) => ({ box: "context", title: "Cache break", summary: one(l.reason ?? l.detail), tone: "warn" }),
  rollover: (l) => ({ box: "context", title: "Handoff", summary: one(l.detail), tone: "warn" }),
  tools: (l) => ({ box: "context", title: "Tool list changed", summary: one(l.detail), tone: "plain" }),
  request: (l) => ({ box: "model", title: "Request", summary: `step ${(Number(l.step) || 0) + 1} · ${l.total} message${l.total === 1 ? "" : "s"} (${(l.add as unknown[] | undefined)?.length ?? 0} new)`, tone: "plain" }),
  thinking: (l) => ({ box: "model", title: "Thinking", summary: one(l.text, 100), tone: "plain" }),
  model: (l) => { const m = (l.message ?? {}) as { content?: string; tool_calls?: { function: { name: string } }[] }, calls = m.tool_calls?.map((c) => c.function.name) ?? []; return { box: "model", title: "Reply", summary: [m.content ? one(m.content, 70) : "", calls.length ? `calls ${calls.join(", ")}` : ""].filter(Boolean).join(" · ") || "(empty)", tone: "plain" }; },
  turn: (l) => ({ box: "model", title: "Usage", summary: `${tok(l.prompt)} in · ${tok(l.completion)} out${Number(l.cached) ? ` · ${tok(l.cached)} cached` : ""}${Number(l.reasoning) ? ` · ${tok(l.reasoning)} reasoning` : ""} · ${dur(l.ms)}`, tone: "plain" }),
  assistant: null, text: null, blob: null, message: null, end: null,
  phase: (l) => (l.phase === "tools" ? { box: "tools", title: "Tool calls", summary: `${l.n ?? "?"} in this step`, tone: "plain" } : l.phase === "verify" ? { box: "finish", title: "Verify", summary: "running the verify command", tone: "plain" } : null as never),
  toolstart: (l) => ({ box: "tools", title: `Call ${l.name}`, summary: argLine(l.args), tone: "plain" }),
  tool: (l) => ({ box: "tools", title: `Result ${l.name}`, summary: `${l.ok === false || bad(l.result) ? "failed" : "ok"}${l.ms !== undefined ? ` · ${dur(l.ms)}` : ""} · ${one(l.result, 70)}`, tone: l.ok === false || bad(l.result) ? "err" : "ok" }),
  edit: (l) => ({ box: "tools", title: `Edit ${l.path}`, summary: `${l.created ? "new file · " : ""}+${l.added} −${l.removed}`, tone: "ok" }),
  policy: (l) => ({ box: "tools", title: `Policy ${l.tool}`, summary: `${l.action}: ${one(l.reason)}`, tone: l.action === "deny" ? "err" : "plain" }),
  approval: (l) => ({ box: "tools", title: `Approval ${l.tool}`, summary: l.ok ? "allowed" : one(l.answer), tone: l.ok ? "ok" : "err" }),
  todos: (l) => ({ box: "tools", title: "Plan", summary: one(((l.todos as { content: string; status: string }[] | undefined) ?? []).map((t) => `${t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "·"} ${t.content}`).join("  ") || l.detail), tone: "plain" }),
  skill: (l) => ({ box: "tools", title: "Skill loaded", summary: one(l.name ?? l.detail), tone: "plain" }),
  plan: (l) => ({ box: "tools", title: "Plan", summary: one(l.detail), tone: "plain" }),
  denied: (l) => ({ box: "guards", title: "Denied", summary: one(l.detail), tone: "err" }),
  nudge: (l) => ({ box: "guards", title: "Nudge", summary: one(l.detail), tone: "warn" }),
  loop: (l) => ({ box: "guards", title: "Loop guard", summary: one(l.detail), tone: "warn" }),
  budget: (l) => ({ box: "guards", title: "Budget", summary: one(l.detail), tone: "warn" }),
  repair: (l) => ({ box: "guards", title: l.fixed ? "Call corrected" : "Call sent back", summary: one(l.detail), tone: "warn" }),
  ladder: (l) => ({ box: "guards", title: `Ladder ${l.action}`, summary: `${l.from} → ${l.to}: ${one(l.reason, 80)}`, tone: "warn" }),
  takeover: (l) => ({ box: "guards", title: "Takeover", summary: `${l.role} on ${l.model}: ${one(l.reason, 80)}`, tone: "warn" }),
  rejected: (l) => ({ box: "finish", title: "Finish rejected", summary: one(l.detail), tone: "warn" }),
  review: (l) => ({ box: "finish", title: "Reviewer", summary: l.pass ? "no problems" : one(((l.findings as string[] | undefined) ?? []).join("; ") || l.detail), tone: l.pass ? "ok" : "warn" }),
  audit: (l) => ({ box: "finish", title: "Audit", summary: `${((l.changed as string[] | undefined) ?? []).length} files changed${((l.notes as string[] | undefined) ?? []).length ? " · " + one((l.notes as string[]).join("; "), 80) : ""}`, tone: ((l.notes as string[] | undefined) ?? []).length ? "warn" : "ok" }),
  finish: (l) => ({ box: "answer", title: "Finished", summary: one(l.summary ?? l.detail), tone: "ok" }),
  aborted: (l) => ({ box: "answer", title: "Interrupted", summary: one(l.detail), tone: "err" }),
};

/** Build frames from trace lines, one line at a time (live lines are fed as they come). */
export class Lifecycle {
  lines: TraceLine[] = []; frames: Frame[] = []; chats: Chat[] = [];
  private step = 0; private chatOpen = false; private reqs?: ReturnType<typeof readRequests>;
  constructor(lines: TraceLine[] = []) { for (const l of lines) this.add(l); }
  add(l: TraceLine) {
    const i = this.lines.push(l) - 1, sub = typeof l.agent === "string" && l.agent !== "lead" ? l.agent : undefined;
    if (l.kind === "request") this.reqs = undefined;
    if (!sub) {
      if (l.kind === "chat" || (l.kind === "run" && !this.chatOpen)) { const f = KIND[l.kind]!(l); this.chats.push({ n: this.chats.length + 1, title: f.summary, first: this.frames.length, last: this.frames.length }); this.step = 0; }
      if (l.kind === "chat") this.chatOpen = true; else if (l.kind === "run") this.chatOpen = false;
      if ((l.kind === "phase" && l.phase === "model") || l.kind === "request") { const s = (Number(l.step) || 0) + 1; if (s !== this.step) this.step = s; }
    }
    const fn = KIND[l.kind]; if (fn === null) return;
    const v = fn ? fn(l) : { box: "guards" as Box, title: l.kind, summary: one(l.detail), tone: "plain" as Tone };
    if (!v) return;
    const fr: Frame = { line: i, t: l.t, ms: l.ms, kind: l.kind, ...v, chat: this.chats.length, step: this.step };
    if (sub) { fr.agent = sub; fr.title = `${sub}: ${v.title}`; }
    this.frames.push(fr);
    const c = this.chats.at(-1); if (c) c.last = this.frames.length - 1;
  }
  /** The frames of one chat, as indexes. */
  chatOf(f: number) { return this.frames[f]?.chat ?? 0; }
  /** The full details of a frame, for the detail panel. */
  detailOf(f: number): Section[] {
    const fr = this.frames[f]; if (!fr) return [];
    const l = this.lines[fr.line], out: Section[] = [], json = (title: string, v: unknown) => out.push({ title, body: typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "", kind: "json" });
    const text = (title: string, v: unknown, kind: Section["kind"] = "text") => { const s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2) ?? ""; if (s) out.push({ title, body: s, kind }); };
    const when = `${new Date(l.t).toLocaleTimeString()} · +${dur(l.ms)}${fr.step ? ` · step ${fr.step}` : ""}${fr.agent ? ` · subagent ${fr.agent}` : ""}`;
    out.push({ title: fr.title, body: `${fr.summary}\n${when}` });
    switch (l.kind) {
      case "chat": text("Message", l.text, "md"); if (l.attachments) text("Attached", (l.attachments as string[]).join("\n")); break;
      case "run": for (const m of (l.messages as { role: string; content?: string }[]) ?? []) text(m.role, m.content ?? ""); break;
      case "request": {
        this.reqs ??= readRequests(this.lines); const r = this.reqs.get(fr.line);
        if (!r) { text("Request", "not recorded (full recording was off)"); break; }
        const sys = r.messages[0]?.role === "system" ? r.messages[0] : undefined, body = sys ? r.messages.slice(1) : r.messages, kept = Number(l.keep) || 0;
        text("Messages", body.map((m, k) => `── ${k + 1}. ${m.role}${k >= kept ? "  (new)" : ""}${m.tool_calls?.length ? ` · calls ${m.tool_calls.map((c) => c.function.name).join(", ")}` : ""}\n${m.content ?? ""}`).join("\n\n"));
        if (sys) text("System prompt", sys.content ?? "", "md");
        text("Tools sent", (r.tools as { name?: string; description?: string }[]).map((t) => `${t.name}: ${one(t.description, 140)}`).join("\n"));
        break;
      }
      case "thinking": text("Thinking", l.text, "md"); break;
      case "model": { const m = (l.message ?? {}) as { content?: string; tool_calls?: { function: { name: string; arguments: string } }[]; usage?: unknown }; text("Text", m.content ?? "", "md"); for (const c of m.tool_calls ?? []) json(`Call ${c.function.name}`, (() => { try { return JSON.parse(c.function.arguments); } catch { return c.function.arguments; } })()); break; }
      case "toolstart": json("Arguments", (() => { try { return JSON.parse(String(l.args)); } catch { return l.args; } })()); break;
      case "tool": text("Result (as the model saw it)", l.result); break;
      case "edit": if (l.diff) text("Diff", l.diff, "diff"); else text("Diff", "not recorded (full recording was off)"); if (typeof l.before === "string") text("File before", l.before); break;
      case "hookrun": json("Input", l.input); for (const r of (l.runs as { command: string; ms: number; outcome: string; output?: string }[]) ?? []) text(`$ ${r.command}`, `${r.outcome} · ${dur(r.ms)}${r.output ? `\n${r.output}` : ""}`); json("Result", l.result); break;
      default: { const { t: _t, ms: _m, kind: _k, agent: _a, detail, ...rest } = l; if (Object.keys(rest).length) json("Fields", rest); else if (detail) text("Detail", detail); }
    }
    return out;
  }
}

/** The next frame after `from` (or before, with dir -1) that matches `pred`; undefined when there is none. */
export function seek(frames: Frame[], from: number, dir: 1 | -1, pred: (f: Frame) => boolean): number | undefined {
  for (let i = from + dir; i >= 0 && i < frames.length; i += dir) if (pred(frames[i])) return i;
  return undefined;
}

// The LOOP section of the sidebar: what the agent loop is doing right now, one line per step, with the harness's interventions shown where they happened.
// It adapts to the room it has: older steps fold into one summary line, the step cap appears only when it starts to matter, and a clicked step opens to show every tool call and note.
import { BOLD, F, fit } from "./rich.ts";
import { clipWidth } from "./text.ts";
import type { Theme } from "./themes.ts";
import { toolLabel } from "./view.ts";

export type LoopStep = { n: number; t0: number; ms: number; tools: { name: string; args: string; ms: number; ok: boolean }[]; notes: string[]; parallel?: number };
export type LoopData = {
  /** the run is still going */ live: boolean; phase: string; cap: number; now: number; frame: number; elapsedMs: number;
  /** this run's steps, oldest first; while live, the last one is the current step */ steps: LoopStep[];
  /** tool calls in flight right now */ inflight: { label: string; ms: number; agent?: string }[];
  /** steps the user opened by clicking */ open: number[];
};
export type LoopHit = { line: number; step: number };

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);
/** Notes that mean "the harness stepped in" (shown in the warning colour, and kept visible); everything else (cache, routing, trimming) is background. */
export const isIntervention = (note: string) => /nudg|reject|denied|loop|stagnat|stuck|budget|step limit|reviewer|wrap|repair/i.test(note);

/** "Read ×2 → Edit → Run": neighbouring calls of one kind merge, so a burst of reads is one short phrase. */
export function stepSummary(tools: { name: string }[]): string {
  const parts: { label: string; n: number }[] = [];
  for (const t of tools) { const label = toolLabel(t.name), last = parts[parts.length - 1]; if (last && last.label === label) last.n++; else parts.push({ label, n: 1 }); }
  return parts.map((p) => (p.n > 1 ? `${p.label} ×${p.n}` : p.label)).join(" → ");
}
/** Wall time of a step: the model call, then its tools (they overlap when run in parallel). */
export const stepMs = (s: LoopStep) => s.ms + (s.parallel && s.parallel > 1 ? Math.max(0, ...s.tools.map((x) => x.ms)) : s.tools.reduce((n, x) => n + x.ms, 0));

/** The cap is a safety stop, not a goal, so say nothing about it until it could matter. */
export function capNote(step: number, cap: number): { text: string; level: "none" | "dim" | "warn" } {
  const r = step / Math.max(1, cap);
  return r >= 0.8 ? { text: `${step}/${cap}: close to the step limit`, level: "warn" } : r >= 0.5 ? { text: `of ${cap} max`, level: "dim" } : { text: "", level: "none" };
}

export function renderLoop(d: LoopData, t: Theme, inner: number, maxRows: number): { lines: string[]; hits: LoopHit[]; title: string; right: string } {
  const lines: string[] = [], hits: LoopHit[] = [];
  const cur = d.live ? d.steps[d.steps.length - 1] : undefined;
  const tools = d.steps.reduce((n, s) => n + s.tools.length, 0), failed = d.steps.reduce((n, s) => n + s.tools.filter((x) => !x.ok).length, 0);
  const title = d.live ? "LOOP" : "LAST RUN", right = F(t.dim, `${Math.round(d.elapsedMs / 1000)}s`);

  if (d.live && cur) {
    const spin = F(t.accent2, SPIN[d.frame % SPIN.length]);
    const state = d.phase === "tools" ? (d.inflight.length > 1 ? `running ${d.inflight.length} tools` : "running a tool") : d.phase === "verify" ? "verifying" : d.phase === "compact" ? "compacting the history" : `thinking ${fmtMs(Math.max(0, d.now - cur.t0))}`;
    const cap = capNote(cur.n, d.cap);
    lines.push(spin + " " + BOLD(F(t.text, `step ${cur.n}`)) + F(t.dim, " · " + state) + (cap.level === "dim" ? F(t.faint, "  " + cap.text) : ""));
    if (cap.level === "warn") {
      const w = Math.max(6, Math.min(20, inner - 4)), f = Math.max(1, Math.min(w, Math.round((cur.n / d.cap) * w)));
      lines.push(F(t.warn, "▰".repeat(f)) + F(t.border, "▱".repeat(w - f)) + F(t.warn, "  " + cap.text));
    }
  }

  // one block of lines per step; the newest steps get the room, older ones fold into a summary line
  type Block = { step: number; lines: string[]; head: boolean };
  const blocks: Block[] = d.steps.map((s) => {
    const isCur = d.live && s === cur, open = d.open.includes(s.n), out: string[] = [];
    const bad = s.tools.some((x) => !x.ok), mark = isCur ? F(t.accent2, "▸") : bad ? F(t.err, "✗") : s.tools.length ? F(t.ok, "✓") : F(t.faint, "·");
    const what = isCur && !s.tools.length && !d.inflight.length ? "thinking…" : s.tools.length || isCur ? stepSummary(s.tools) || (d.inflight.length ? "…" : "") : "replied";
    const time = isCur ? "" : fmtMs(stepMs(s)), num = String(s.n).padStart(2);
    const body = clipWidth(what, Math.max(4, inner - 9 - time.length));
    out.push(F(t.faint, num) + " " + mark + " " + (isCur ? F(t.text, body) : F(bad ? t.err : t.dim, body)) + (time ? F(t.faint, " " + time) : ""));
    const showAll = open || isCur;
    if (open) for (const x of s.tools) out.push("     " + (x.ok ? F(t.ok, "✓ ") : F(t.err, "✗ ")) + F(t.dim, clipWidth(`${toolLabel(x.name)} ${shortArgs(x.args)}`, inner - 12)) + F(t.faint, ` ${fmtMs(x.ms)}`));
    if (isCur) for (const x of d.inflight.slice(0, 3)) out.push("     " + F(t.accent2, SPIN[d.frame % SPIN.length]) + " " + F(t.text, clipWidth((x.agent && x.agent !== "lead" ? "↳ " : "") + x.label, inner - 13)) + F(t.faint, ` ${fmtMs(x.ms)}`));
    if (isCur && d.inflight.length > 3) out.push("     " + F(t.faint, `+${d.inflight.length - 3} more running`));
    for (const n of s.notes) {
      const hot = isIntervention(n);
      if (!(hot || showAll || s.n >= (d.steps[d.steps.length - 1]?.n ?? 0) - 2)) continue;
      // what the harness did is worth reading in full: an intervention wraps to two lines, background notes are clipped to one
      const parts = hot ? wrapWords(n, inner - 7, 2) : [clipWidth(n, inner - 7)];
      parts.forEach((l, i) => out.push("   " + (i ? "  " : F(hot ? t.warn : t.faint, hot ? "⚑ " : "· ")) + F(hot ? t.dim : t.faint, l)));
    }
    return { step: s.n, lines: out, head: true };
  });

  // newest first until the room is used; reserve a line for "N earlier steps" when something is left out
  const room = Math.max(3, maxRows - lines.length - 1);
  let used = 0, from = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) { const need = blocks[i].lines.length; if (used + need > room && from < blocks.length) break; used += need; from = i; }
  const left = blocks.slice(0, from);
  if (left.length) {
    const lt = left.reduce((n, b) => n + d.steps.find((s) => s.n === b.step)!.tools.length, 0), lf = left.reduce((n, b) => n + d.steps.find((s) => s.n === b.step)!.tools.filter((x) => !x.ok).length, 0);
    lines.push(F(t.faint, `… ${left.length} earlier step${left.length === 1 ? "" : "s"} · ${lt} tool${lt === 1 ? "" : "s"}${lf ? ` · ${lf} failed` : ""}`));
  }
  for (const b of blocks.slice(from)) { hits.push({ line: lines.length, step: b.step }); lines.push(...b.lines); }
  if (!d.live || d.steps.length > 1) lines.push(F(t.faint, `${d.steps.length} step${d.steps.length === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}${failed ? " · " : ""}`) + (failed ? F(t.err, `${failed} failed`) : ""));
  void fit;
  return { lines, hits, title, right };
}

function wrapWords(s: string, w: number, maxLines: number): string[] {
  const lines: string[] = [""];
  for (const word of s.split(/\s+/)) { const last = lines[lines.length - 1]; if ((last + " " + word).trim().length <= w) lines[lines.length - 1] = (last + " " + word).trim(); else lines.push(word); }
  const cut = lines.slice(0, maxLines); if (lines.length > maxLines) cut[maxLines - 1] = clipWidth(cut[maxLines - 1], w - 1) + "…";
  return cut.map((l) => clipWidth(l, w));
}
function shortArgs(raw: string): string { try { const a = JSON.parse(raw); return String(a.path ?? a.cmd ?? a.pattern ?? a.query ?? a.url ?? a.name ?? "").replace(/\s+/g, " "); } catch { return ""; } }

// The LOOP section of the sidebar: the cycle the agent goes round (gather context, act, verify), which part of it is running now, and the latest steps, with the harness's
// interventions shown where they happened. The stages are INFERRED from the tool calls (the harness has no gather/act/verify phases of its own): reads and searches gather,
// edits and most commands act, test/build/lint/typecheck commands and the verify gate verify. It adapts to the room it has: older steps fold into one summary line, the step cap
// appears only when it starts to matter, and a clicked step opens to show every tool call and note. The full history is the /loop command.
import { mix } from "./ansi.ts";
import { BOLD, F } from "./rich.ts";
import { clipWidth } from "./text.ts";
import type { Theme } from "./themes.ts";
import { toolLabel } from "./view.ts";

export type LoopStep = { n: number; t0: number; ms: number; tools: { name: string; args: string; ms: number; ok: boolean }[]; notes: string[]; parallel?: number };
export type LoopData = {
  /** the run is still going */ live: boolean; phase: string; cap: number; now: number; frame: number; elapsedMs: number;
  /** this run's steps, oldest first; while live, the last one is the current step */ steps: LoopStep[];
  /** tool calls in flight right now (name and args let the panel tell which stage they belong to) */ inflight: { label: string; ms: number; agent?: string; name?: string; args?: string }[];
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

// ------------------------------------------------------------------------------------------------------------------ stages
export type Stage = "gather" | "act" | "verify";
export const STAGES: Stage[] = ["gather", "act", "verify"];
export const STAGE_GLYPH: Record<Stage, string> = { gather: "◉", act: "✎", verify: "✓" };
const GATHER_TOOLS = new Set(["read_file", "list_files", "grep", "repo_map", "find_refs", "impact", "web_search", "fetch_url", "memory_search", "tool_search", "skill", "task", "sh_list", "sh_read"]);
const NEUTRAL_TOOLS = new Set(["todo_write", "memory_save", "memory_forget", "exit_plan_mode", "finish"]);       // planning and bookkeeping: not part of the cycle
const VERIFY_CMD = /\b(tests?|pytest|jest|vitest|mocha|tsc|typecheck|type-check|lint|eslint|ruff|mypy|pyright|flake8|clippy|rspec|phpunit|verify|check)\b|\b(cargo|go|npm|yarn|pnpm|make|gradle|mvn|dotnet|swift)\s+(run\s+)?(test|build|check|vet|lint|clippy|verify)\b|node\s+--test|\bbuild\b/i;
const LOOK_CMD = /^\s*(ls|cat|head|tail|less|grep|rg|find|tree|pwd|wc|stat|file|which|du|df|git\s+(status|diff|log|show|branch|blame)|sed\s+-n)\b/;

/** Which part of the cycle a tool call belongs to. A guess from the tool and, for shell commands, the command line; undefined for planning and bookkeeping tools. */
export function stageOfTool(name: string, args = ""): Stage | undefined {
  if (NEUTRAL_TOOLS.has(name)) return undefined;
  if (GATHER_TOOLS.has(name)) return "gather";
  if (name === "sh" || name === "sh_start") {
    let cmd = ""; try { cmd = String(JSON.parse(args).cmd ?? ""); } catch { cmd = args; }
    return LOOK_CMD.test(cmd) ? "gather" : VERIFY_CMD.test(cmd) ? "verify" : "act";
  }
  return "act";
}
/** The stages a step touched, in cycle order. */
export const stagesOf = (tools: { name: string; args: string }[]): Stage[] => STAGES.filter((st) => tools.some((x) => stageOfTool(x.name, x.args) === st));
/** How many times the agent has come back round: a new round starts when it gathers or acts again after verifying. */
export function roundOf(steps: LoopStep[]): number {
  let round = 1, verified = false;
  for (const s of steps) { const st = stagesOf(s.tools); if (verified && (st.includes("gather") || st.includes("act"))) { round++; verified = false; } if (st.includes("verify")) verified = true; }
  return round;
}

/** Which stages to light: those running now, and (while the model is thinking and nothing runs) the last one used, dimmed. */
export function litStages(d: LoopData): { now: Set<Stage>; recent: Set<Stage> } {
  const now = new Set<Stage>(), recent = new Set<Stage>(), cur = d.steps[d.steps.length - 1];
  if (d.live) {
    if (d.phase === "verify") now.add("verify");
    else if (d.phase === "tools") {
      for (const x of d.inflight) { const st = x.name ? stageOfTool(x.name, x.args) : undefined; if (st) now.add(st); }
      if (!now.size && cur) { const last = cur.tools[cur.tools.length - 1]; const st = last && stageOfTool(last.name, last.args); if (st) now.add(st); }
    }
  }
  if (!now.size) for (let i = d.steps.length - 1; i >= 0; i--) { const st = stagesOf(d.steps[i].tools); if (st.length) { st.forEach((x) => recent.add(x)); break; } }
  return { now, recent };
}

export function renderLoop(d: LoopData, t: Theme, inner: number, maxRows: number): { lines: string[]; hits: LoopHit[]; title: string; right: string } {
  const lines: string[] = [], hits: LoopHit[] = [];
  const cur = d.live ? d.steps[d.steps.length - 1] : undefined, round = roundOf(d.steps);
  const tools = d.steps.reduce((n, s) => n + s.tools.length, 0), failed = d.steps.reduce((n, s) => n + s.tools.filter((x) => !x.ok).length, 0);
  const color: Record<Stage, number> = { gather: t.tool.read, act: t.tool.edit, verify: t.ok };
  const title = d.live ? "LOOP" : "LAST RUN";
  const cap = cur ? capNote(cur.n, d.cap) : { text: "", level: "none" as const };
  const right = d.live && cur ? F(t.dim, `round ${round} · step ${cur.n}${cap.level === "dim" ? " of " + d.cap : ""}`) : F(t.dim, `${Math.round(d.elapsedMs / 1000)}s`);
  const spin = F(t.accent2, SPIN[d.frame % SPIN.length]);

  // the cycle: the stage that is running is bright, the one just used (while the model thinks) is half-bright, the rest are dim. A verify that failed stays red until the next one passes.
  const { now, recent } = litStages(d);
  let verifyFailed = false;
  for (const s of d.steps) { const v = s.tools.filter((x) => stageOfTool(x.name, x.args) === "verify"); if (v.length) verifyFailed = v.some((x) => !x.ok); }
  const compact = inner < 27;
  const cycle = STAGES.map((st) => {
    const c = st === "verify" && verifyFailed ? t.err : color[st], label = compact ? "" : " " + st, text = STAGE_GLYPH[st] + label;
    return now.has(st) ? BOLD(F(c, text)) : recent.has(st) || (st === "verify" && verifyFailed) ? F(mix(c, t.surface, 0.35), text) : F(t.faint, text);
  }).join(F(t.border, " ▸ "));
  lines.push(cycle);

  if (d.live && cur) {
    const act = d.phase === "compact" ? "compacting the history" : d.phase === "verify" ? "verifying the result" : d.phase === "tools" && d.inflight.length ? "" : `thinking ${fmtMs(Math.max(0, d.now - cur.t0))}`;
    if (act) lines.push(spin + " " + F(t.dim, act));
    else { const x = d.inflight[0]; lines.push(spin + " " + F(t.text, clipWidth((x.agent && x.agent !== "lead" ? "↳ " : "") + x.label, inner - 9)) + F(t.faint, ` ${fmtMs(x.ms)}`)); if (d.inflight.length > 1) lines.push("  " + F(t.faint, `+${d.inflight.length - 1} more running`)); }
    if (cap.level === "warn") {
      const w = Math.max(6, Math.min(20, inner - 4)), f = Math.max(1, Math.min(w, Math.round((cur.n / d.cap) * w)));
      lines.push(F(t.warn, "▰".repeat(f)) + F(t.border, "▱".repeat(w - f)) + F(t.warn, "  " + cap.text));
    }
  }

  // one block of lines per step. The newest few are shown; a step the harness intervened in stays visible; the rest fold into one line.
  type Block = { step: number; lines: string[]; must: boolean };
  const lastN = d.steps[d.steps.length - 1]?.n ?? 0;
  const blocks: Block[] = d.steps.map((s) => {
    const isCur = d.live && s === cur, open = d.open.includes(s.n), out: string[] = [], bad = s.tools.some((x) => !x.ok);
    const st = isCur && now.size ? [...now] : stagesOf(s.tools);
    const glyphs = st.length ? st.map((x) => F(bad && !isCur ? t.err : color[x], STAGE_GLYPH[x])).join("") : isCur ? F(t.accent2, "▸") : F(t.faint, "·");
    const what = isCur && !s.tools.length && !d.inflight.length ? "thinking…" : s.tools.length || isCur ? stepSummary(s.tools) || (d.inflight.length ? "…" : "") : "replied";
    const time = isCur ? "" : fmtMs(stepMs(s)), num = String(s.n).padStart(2);
    const body = clipWidth(what, Math.max(4, inner - 8 - st.length - (bad && !isCur ? 2 : 0) - time.length));
    out.push(F(t.faint, num) + " " + glyphs + " " + (isCur ? F(t.text, body) : F(bad ? t.err : t.dim, body)) + (bad && !isCur ? F(t.err, " ✗") : "") + (time ? F(t.faint, " " + time) : ""));
    const showAll = open || isCur;
    if (open) for (const x of s.tools) out.push("     " + (x.ok ? F(t.ok, "✓ ") : F(t.err, "✗ ")) + F(t.dim, clipWidth(`${toolLabel(x.name)} ${shortArgs(x.args)}`, inner - 12)) + F(t.faint, ` ${fmtMs(x.ms)}`));
    let hotNote = false;
    for (const n of s.notes) {
      const hot = isIntervention(n); hotNote ||= hot;
      if (!(hot || showAll || s.n >= lastN - 2)) continue;
      // what the harness did is worth reading in full: an intervention wraps to two lines, background notes are clipped to one
      const parts = hot ? wrapWords(n, inner - 7, 2) : [clipWidth(n, inner - 7)];
      parts.forEach((l, i) => out.push("   " + (i ? "  " : F(hot ? t.warn : t.faint, hot ? "⚑ " : "· ")) + F(hot ? t.dim : t.faint, l)));
    }
    return { step: s.n, lines: out, must: s.n > lastN - 12 && (hotNote || open) };
  });

  // choose from the newest back: about as many steps as the room allows (3 when it is short), and every step that has an intervention or was opened
  const room = Math.max(3, maxRows - lines.length - 1), nominal = Math.max(3, Math.min(8, Math.floor(room / 2)));
  const shown = new Set<number>(); let used = 0, count = 0;
  const fitsAll = blocks.reduce((n, b) => n + b.lines.length, 0) <= room;       // everything fits: fold nothing
  for (let i = blocks.length - 1; i >= 0 && fitsAll; i--) shown.add(i);
  for (let i = blocks.length - 1; i >= 0 && !fitsAll; i--) {
    const b = blocks[i], need = b.lines.length;
    if (!shown.size) { shown.add(i); used += need; count++; continue; }                       // the newest step is always there
    if (used + need <= room && (count < nominal || b.must)) { shown.add(i); used += need; count++; }
  }
  const hidden = blocks.filter((_, i) => !shown.has(i));
  const firstShown = Math.min(...shown);
  if (hidden.length && blocks.findIndex((_, i) => !shown.has(i)) < firstShown) {
    const old = blocks.slice(0, firstShown), ot = old.reduce((n, b) => n + d.steps.find((s) => s.n === b.step)!.tools.length, 0), of = old.reduce((n, b) => n + d.steps.find((s) => s.n === b.step)!.tools.filter((x) => !x.ok).length, 0);
    lines.push(F(t.faint, `… ${old.length} earlier step${old.length === 1 ? "" : "s"} · ${ot} tool${ot === 1 ? "" : "s"}${of ? ` · ${of} failed` : ""}`));
  }
  blocks.forEach((b, i) => { if (!shown.has(i)) return; hits.push({ line: lines.length, step: b.step }); lines.push(...b.lines); });
  if (!d.live || hidden.length) lines.push(F(t.faint, `${d.steps.length} step${d.steps.length === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}${failed ? " · " : ""}`) + (failed ? F(t.err, `${failed} failed`) : "") + F(t.faint, "  /loop: all"));
  return { lines, hits, title, right };
}

function wrapWords(s: string, w: number, maxLines: number): string[] {
  const lines: string[] = [""];
  for (const word of s.split(/\s+/)) { const last = lines[lines.length - 1]; if ((last + " " + word).trim().length <= w) lines[lines.length - 1] = (last + " " + word).trim(); else lines.push(word); }
  const cut = lines.slice(0, maxLines); if (lines.length > maxLines) cut[maxLines - 1] = clipWidth(cut[maxLines - 1], w - 1) + "…";
  return cut.map((l) => clipWidth(l, w));
}
function shortArgs(raw: string): string { try { const a = JSON.parse(raw); return String(a.path ?? a.cmd ?? a.pattern ?? a.query ?? a.url ?? a.name ?? "").replace(/\s+/g, " "); } catch { return ""; } }

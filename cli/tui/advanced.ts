// The Advanced view's state and actions, shared by the terminal (cli/tui/advancedview.ts draws it) and the desktop (cli/desktop/bridge.ts sends it as data).
// It shows a session's lifecycle (cli/tui/lifecycle.ts) as boxes you move between, frame by frame, and holds the pauses: a box with a pause stops the run
// at its pause points, and while the run waits you can change what goes on (src/harness.ts Options.pause applies the change and reports it).
import { GUARD_NAMES, type Guard, type PauseEdit, type PausePoint, type TraceLine } from "../../src/index.ts";
import type { App } from "./app.ts";
import type { Key } from "./keys.ts";
import { BOXES, Lifecycle, PAUSABLE, boxLabel, boxOfPause, seek, type Box, type Frame } from "./lifecycle.ts";

export type PauseMode = "always" | "once";

/** Pauses by box, and the pause the run is waiting at (if any). Kept by the App, so pauses stay set while the view is closed. */
export class PauseBook {
  boxes = new Map<Box, PauseMode>();
  /** pause at the next pause point, whatever box it is in ("." in the view) */ next = false;
  waiting?: { point: PausePoint; box: Box; edit: PauseEdit; since: number; resolve: (e?: PauseEdit) => void };
  get any() { return this.next || this.boxes.size > 0; }
  /** Does the run stop at this point? A "once" pause is used up by it. */
  take(p: PausePoint): boolean {
    const box = boxOfPause(p.at), mode = this.boxes.get(box);
    if (!this.next && !mode) return false;
    this.next = false; if (mode === "once") this.boxes.delete(box);
    return true;
  }
  /** Off → every time → once → off. Returns the new mode, or undefined when the box has no pause points. */
  cycle(box: Box): PauseMode | "off" | undefined {
    if (!PAUSABLE[box]) return undefined;
    const now = this.boxes.get(box), to: PauseMode | "off" = !now ? "always" : now === "always" ? "once" : "off";
    if (to === "off") this.boxes.delete(box); else this.boxes.set(box, to);
    return to;
  }
  /** Let the run go on, with what was changed (nothing changed = undefined). */
  release(o: { next?: boolean } = {}) {
    const w = this.waiting; if (!w) return; this.waiting = undefined; if (o.next) this.next = true;
    w.resolve(Object.keys(w.edit).length ? w.edit : undefined);
  }
}

/** Where the view reads from: the session running here (live), or a saved trace. */
export type Source = { live: true; title: string } | { live: false; title: string; file: string };

export class AdvancedView {
  lc: Lifecycle; cur = 0; follow = true; focus: Box = "model"; filter?: Box; scroll = 0; playing = false; source: Source;
  private timer?: ReturnType<typeof setInterval>;
  constructor(lines: TraceLine[], source: Source) { this.lc = new Lifecycle(lines); this.source = source; this.cur = this.last(); }
  get live() { return this.source.live; }
  get frames() { return this.lc.frames; }
  get frame(): Frame | undefined { return this.lc.frames[this.cur]; }
  /** A live line arrived: follow it when following. */
  add(l: TraceLine) { const n = this.lc.frames.length; this.lc.add(l); if (this.follow && this.lc.frames.length > n) { this.cur = this.last(); this.scroll = 0; } }
  private ok = (f: Frame) => !this.filter || f.box === this.filter;
  last() { for (let i = this.lc.frames.length - 1; i >= 0; i--) if (this.ok(this.lc.frames[i])) return i; return Math.max(0, this.lc.frames.length - 1); }
  go(i: number | undefined) { if (i === undefined) return; this.cur = Math.max(0, Math.min(i, this.lc.frames.length - 1)); this.scroll = 0; this.follow = this.live && this.cur >= this.last(); }
  /** One frame back or forward (within the filter). */
  move(d: 1 | -1) { this.go(seek(this.frames, this.cur, d, this.ok)); }
  /** To the first frame of the next or previous loop step. */
  step(d: 1 | -1) { const f = this.frame; if (!f) return; const i = seek(this.frames, this.cur, d, (x) => this.ok(x) && (x.step !== f.step || x.chat !== f.chat)); if (i === undefined) return; if (d === -1) { const s = this.frames[i]; let j = i; while (j > 0 && this.frames[j - 1].step === s.step && this.frames[j - 1].chat === s.chat) j--; this.go(j); } else this.go(i); }
  /** To the first frame of the next or previous chat. */
  chat(d: 1 | -1) { const c = this.frame?.chat ?? 0, ch = this.lc.chats.find((x) => x.n === c + d); if (ch) this.go(ch.first); else if (d === -1) this.go(0); else this.go(this.last()); }
  home() { this.go(seek(this.frames, -1, 1, this.ok) ?? 0); }
  end() { this.go(this.last()); this.follow = this.live; }
  /** The next time a box ran, after the current frame (from the start again at the end). */
  jumpBox(b: Box) { this.focus = b; this.go(seek(this.frames, this.cur, 1, (f) => f.box === b) ?? seek(this.frames, -1, 1, (f) => f.box === b)); }
  /** Frames per box in the current chat (the numbers on the boxes). */
  counts(): Record<Box, number> { const c = this.frame?.chat ?? 0, out = Object.fromEntries(BOXES.map((b) => [b.id, 0])) as Record<Box, number>; for (const f of this.frames) if (f.chat === c) out[f.box]++; return out; }
  /** Space: step forward on a timer until the end (or a pause). */
  togglePlay(onTick: () => void) {
    if (this.playing) { this.stopPlay(); return; }
    this.playing = true; this.follow = false;
    this.timer = setInterval(() => { if (this.cur >= this.last()) { this.stopPlay(); this.follow = this.live; } else this.move(1); onTick(); }, 350);
  }
  stopPlay() { this.playing = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  close() { this.stopPlay(); }
}

// ------------------------------------------------------------------------------------------------------------------ pause actions (both front ends)
const GUARDS = GUARD_NAMES as readonly string[];
/** In words: where the run is waiting, and what you can change there. */
export function pauseHelp(p: PausePoint): { where: string; edit: string } {
  switch (p.at) {
    case "model": return { where: `before model call (step ${p.step + 1} of at most ${p.max})`, edit: "add a note to the model, limit its tools for this call, change the step limit or the guards" };
    case "reply": return { where: `after the model's reply (step ${p.step + 1})`, edit: "edit the reply text or its tool calls" };
    case "tool": return { where: `before ${p.name} runs (step ${p.step + 1})`, edit: "edit the arguments, skip the call, or deny it" };
    case "result": return { where: `after ${p.name} ran (step ${p.step + 1})`, edit: "edit the result the model will see" };
    case "finish": return { where: `the model calls finish (step ${p.step + 1})`, edit: "reject it with a reason, or accept it without the checks" };
  }
}
/** What the main edit action changes at this point, and its current text. */
export function editTarget(p: PausePoint, e: PauseEdit): { field: "note" | "content" | "args" | "result" | "reject"; label: string; text: string } {
  switch (p.at) {
    case "model": return { field: "note", label: "Note to the model (added before this call)", text: e.note ?? "" };
    case "reply": return { field: "content", label: "Reply text", text: e.content !== undefined ? e.content ?? "" : p.content ?? "" };
    case "tool": return { field: "args", label: `${p.name} arguments (JSON)`, text: JSON.stringify(e.args ?? p.args, null, 2) };
    case "result": return { field: "result", label: `${p.name} result, as the model will see it`, text: e.result ?? p.result };
    case "finish": return { field: "reject", label: "Reject the finish: what should it fix?", text: e.reject ?? "" };
  }
}
/** One-line list of what has been changed so far at this pause. */
export function editSummary(e: PauseEdit): string {
  const out: string[] = [];
  if (e.note) out.push("note"); if (e.tools) out.push(`tools: ${e.tools.join(", ") || "none"}`); if (e.maxSteps) out.push(`step limit ${e.maxSteps}`);
  if (e.off?.length) out.push(`off: ${e.off.join(", ")}`); if (e.on?.length) out.push(`on: ${e.on.join(", ")}`);
  if (e.content !== undefined) out.push("reply edited"); if (e.calls) out.push("tool calls edited"); if (e.args) out.push("arguments edited");
  if (e.result !== undefined) out.push("result edited"); if (e.reject) out.push("reject"); if (e.accept) out.push("accept");
  return out.join(" · ");
}

export type PauseOp =
  | { op: "continue" } | { op: "next" } | { op: "skip"; why?: string } | { op: "deny"; why?: string } | { op: "accept" } | { op: "discard" }
  | { op: "set"; field: "note" | "content" | "args" | "result" | "reject"; text: string }
  | { op: "calls"; json: string } | { op: "tools"; names: string[] | null } | { op: "steps"; n: number } | { op: "guard"; guard: string; on: boolean };

/** Apply one action at the current pause. Returns an error message for a value that is not accepted (bad JSON, unknown guard), else undefined. */
export function pauseOp(book: PauseBook, o: PauseOp): string | undefined {
  const w = book.waiting; if (!w) return "the run is not paused";
  const p = w.point, e = w.edit;
  switch (o.op) {
    case "continue": book.release(); return;
    case "next": book.release({ next: true }); return;
    case "discard": w.edit = {}; return;
    case "skip": if (p.at !== "tool") return "only a tool call can be skipped"; e.skip = o.why ?? ""; book.release(); return;
    case "deny": if (p.at !== "tool") return "only a tool call can be denied"; e.deny = o.why || "denied while paused"; book.release(); return;
    case "accept": if (p.at !== "finish") return "only a finish can be accepted"; e.accept = true; delete e.reject; book.release(); return;
    case "set": {
      if (o.field === "args") { if (p.at !== "tool") return "arguments belong to a tool call"; try { const v = JSON.parse(o.text); if (!v || typeof v !== "object" || Array.isArray(v)) return "the arguments must be a JSON object"; e.args = v; } catch (x) { return `not valid JSON: ${(x as Error).message}`; } return; }
      if (o.field === "note") { if (p.at !== "model") return "a note goes before a model call"; if (o.text.trim()) e.note = o.text; else delete e.note; return; }
      if (o.field === "content") { if (p.at !== "reply") return "the reply text belongs to a reply"; e.content = o.text; return; }
      if (o.field === "result") { if (p.at !== "result") return "a result belongs to a finished tool call"; e.result = o.text; return; }
      if (p.at !== "finish") return "only a finish can be rejected"; if (o.text.trim()) { e.reject = o.text; delete e.accept; } else delete e.reject; return;
    }
    case "calls": {
      if (p.at !== "reply") return "tool calls belong to a reply";
      try { const v = JSON.parse(o.json); if (!Array.isArray(v)) return "a JSON list of { name, args } objects";
        e.calls = v.map((c, i) => ({ id: String(c.id ?? p.calls[i]?.id ?? ""), name: String(c.name ?? ""), args: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}) }));
        if (e.calls.some((c) => !c.name)) { delete e.calls; return "every call needs a name"; } } catch (x) { return `not valid JSON: ${(x as Error).message}`; }
      return;
    }
    case "tools": if (p.at !== "model") return "the tool list is chosen before a model call"; if (o.names) e.tools = o.names; else delete e.tools; return;
    case "steps": if (!(o.n > p.step + 1)) return `the limit must be above the current step (${p.step + 1})`; e.maxSteps = Math.floor(o.n); return;
    case "guard": {
      if (!GUARDS.includes(o.guard)) return `no guard called ${o.guard} (guards: ${GUARDS.join(", ")})`;
      const g = o.guard as Guard, add = o.on ? "on" : "off", other = o.on ? "off" : "on";
      e[other] = (e[other] ?? []).filter((x) => x !== g); if (!e[other]!.length) delete e[other];
      e[add] = [...new Set([...(e[add] ?? []), g])]; return;
    }
  }
}

/** The tool calls of a reply, as the JSON you edit. */
export const callsJson = (p: Extract<PausePoint, { at: "reply" }>, e: PauseEdit) => JSON.stringify((e.calls ?? p.calls).map((c) => ({ id: c.id, name: c.name, args: (() => { try { return JSON.parse(c.args); } catch { return c.args; } })() })), null, 2);

// ------------------------------------------------------------------------------------------------------------------ keys (terminal)
/** Keys of the Advanced view in the terminal. Returns false for a key it does not use (it then does nothing: the view owns the keyboard while open). */
export function advancedKey(app: App, v: AdvancedView, k: Key): boolean {
  const book = app.pauses, w = book.waiting, ch = k.name === "char" && !k.ctrl && !k.alt ? k.text ?? "" : "";
  const say = (m: string | undefined, ok = "") => { if (m) app.toast(m, "warn"); else if (ok) app.toast(ok, "info"); };
  if (k.name === "escape" || (ch === "q" && !w)) { app.closeAdvanced(); return true; }
  if (k.name === "left") { v.move(-1); v.stopPlay(); } else if (k.name === "right") { v.move(1); v.stopPlay(); }
  else if (ch === "[") v.step(-1); else if (ch === "]") v.step(1);
  else if (k.name === "pageup") v.chat(-1); else if (k.name === "pagedown") v.chat(1);
  else if (k.name === "home") v.home(); else if (k.name === "end") v.end();
  else if (k.name === "up") v.scroll = Math.max(0, v.scroll - (k.shift ? 10 : 1)); else if (k.name === "down") v.scroll += k.shift ? 10 : 1;
  else if (k.name === "tab" || k.name === "backtab") { const i = BOXES.findIndex((b) => b.id === v.focus), d = k.name === "backtab" || k.shift ? -1 : 1; v.focus = BOXES[(i + d + BOXES.length) % BOXES.length].id; }
  else if (k.name === "enter") v.jumpBox(v.focus);
  else if (ch === " ") v.togglePlay(() => app.render());
  else if (ch === "f") { v.filter = v.filter === v.focus ? undefined : v.focus; app.toast(v.filter ? `showing only ${boxLabel(v.filter)}` : "showing every box"); if (v.frame && v.filter && v.frame.box !== v.filter) v.jumpBox(v.filter); }
  else if (ch === "b") { const m = book.cycle(v.focus); app.toast(m === undefined ? `${boxLabel(v.focus)} has no pause points: pauses work on ${Object.keys(PAUSABLE).map((b) => boxLabel(b as Box)).join(", ")}` : m === "off" ? `no pause on ${boxLabel(v.focus)}` : `pause on ${boxLabel(v.focus)} ${m === "once" ? "once" : "every time"}: ${PAUSABLE[v.focus]}`, m === undefined ? "warn" : "info"); }
  else if (ch === ".") { book.next = !book.next; app.toast(book.next ? "pausing at the next pause point" : "no pause at the next point"); }
  else if (ch === "o") void app.openAdvancedPicker();
  else if (w && ch === "c") { book.release(); app.toast("going on"); }
  else if (w && ch === "n") { book.release({ next: true }); app.toast("going on to the next pause point"); }
  else if (w && ch === "s") say(pauseOp(book, { op: "skip" }), "skipped");
  else if (w && ch === "d") void app.askText("Deny this call: why? (the model is told)").then((t) => { if (t !== undefined) say(pauseOp(book, { op: "deny", why: t }), "denied"); app.render(); });
  else if (w && ch === "a") say(pauseOp(book, { op: "accept" }), "accepted without the checks");
  else if (w && ch === "x") { pauseOp(book, { op: "discard" }); app.toast("changes discarded"); }
  else if (w && ch === "e") void editMain(app);
  else if (w && ch === "p") void editParams(app);
  else return false;
  app.render(); return true;
}

export async function editMain(app: App) {
  const w = app.pauses.waiting; if (!w) return;
  const t = editTarget(w.point, w.edit);
  const text = t.field === "reject" ? await app.askText(t.label, { initial: t.text }) : await app.editLongText(t.label, t.text);
  if (text === undefined || !app.pauses.waiting) return;
  const err = pauseOp(app.pauses, { op: "set", field: t.field, text }); app.toast(err ?? `${t.field} changed: c to go on`, err ? "warn" : "info"); app.render();
}

export async function editParams(app: App) {
  const w = app.pauses.waiting; if (!w) return;
  const p = w.point, items: { label: string; value: string; hint?: string }[] = [
    { label: "Step limit", value: "steps", hint: "the most model calls in this run" },
    { label: "Guards", value: "guards", hint: "switch one off (or on again) from now on" },
    ...(p.at === "model" ? [{ label: "Tools for this call", value: "tools", hint: "names, comma separated; empty = all" }] : []),
    ...(p.at === "reply" ? [{ label: "Tool calls (JSON)", value: "calls", hint: "edit, add or remove calls" }] : []),
    ...(p.at === "finish" ? [{ label: "Accept without the checks", value: "accept" }] : []),
    { label: "Discard my changes here", value: "discard" },
  ];
  const what = await app.pick("Change at this pause", items); if (!what || !app.pauses.waiting) return app.render();
  let err: string | undefined;
  if (what === "steps") { const t = await app.askText(`Step limit (now ${p.at === "model" ? p.max : "unchanged"})`); if (t) err = pauseOp(app.pauses, { op: "steps", n: Number(t) }); }
  else if (what === "guards") {
    const g = await app.pick("Guard", GUARDS.map((x) => ({ label: x, value: x }))); if (g) { const on = await app.pick(`${g}`, [{ label: "Off from now on", value: false }, { label: "On again", value: true }]); if (on !== undefined) err = pauseOp(app.pauses, { op: "guard", guard: g, on }); }
  } else if (what === "tools" && p.at === "model") { const t = await app.askText(`Tools for this call (of ${p.tools.length}: ${p.tools.slice(0, 12).join(", ")}${p.tools.length > 12 ? "…" : ""})`, { initial: w.edit.tools?.join(", ") ?? "" }); if (t !== undefined) err = pauseOp(app.pauses, { op: "tools", names: t.trim() ? t.split(/[\s,]+/).filter(Boolean) : null }); }
  else if (what === "calls" && p.at === "reply") { const t = await app.editLongText("Tool calls (JSON list of { name, args })", callsJson(p, w.edit)); if (t !== undefined) err = pauseOp(app.pauses, { op: "calls", json: t }); }
  else if (what === "accept") err = pauseOp(app.pauses, { op: "accept" });
  else if (what === "discard") err = pauseOp(app.pauses, { op: "discard" });
  app.toast(err ?? "changed: c to go on", err ? "warn" : "info"); app.render();
}

// ------------------------------------------------------------------------------------------------------------------ data for the desktop and the inline view
export type AdvancedData = {
  title: string; live: boolean; follow: boolean; playing: boolean; filter?: Box; focus: Box;
  boxes: { id: Box; label: string; glyph: string; help: string; count: number; pause?: PauseMode; pausable: boolean; active: boolean; from: boolean; paused: boolean }[];
  cur: number; total: number; chat: number; chats: { n: number; title: string; first: number }[];
  /** the whole session in at most 240 buckets: the worst tone in each, and the frame it starts at */ timeline: { at: number; tone: Frame["tone"]; chat: number; here: boolean }[];
  /** frames around the current one */ list: (Frame & { i: number })[];
  detail: ReturnType<Lifecycle["detailOf"]>;
  paused?: { box: Box; where: string; edit: string; changes: string; target: ReturnType<typeof editTarget>; at: PausePoint["at"]; calls?: string; tools?: string[]; max?: number; guards: string[] };
  next: boolean;
};
const RANK = { plain: 0, ok: 1, you: 2, warn: 3, err: 4 } as const;
export function advancedData(v: AdvancedView, book: PauseBook, o: { around?: number } = {}): AdvancedData {
  const fr = v.frame, prev = fr ? seek(v.frames, v.cur, -1, (f) => f.box !== fr.box) : undefined, counts = v.counts(), n = v.frames.length, w = book.waiting;
  const buckets = Math.min(240, n), timeline: AdvancedData["timeline"] = [];
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor((b * n) / buckets), z = Math.max(a + 1, Math.floor(((b + 1) * n) / buckets)); let tone: Frame["tone"] = "plain";
    for (let i = a; i < z; i++) if (RANK[v.frames[i].tone] > RANK[tone]) tone = v.frames[i].tone;
    timeline.push({ at: a, tone, chat: v.frames[a].chat, here: v.cur >= a && v.cur < z });
  }
  const around = o.around ?? 30, lo = Math.max(0, v.cur - around), list = v.frames.slice(lo, v.cur + around + 1).map((f, k) => ({ ...f, i: lo + k })).filter((f) => !v.filter || f.box === v.filter);
  return {
    title: v.source.title, live: v.live, follow: v.follow, playing: v.playing, filter: v.filter, focus: v.focus, next: book.next,
    boxes: BOXES.map((b) => ({ ...b, count: counts[b.id], pause: book.boxes.get(b.id), pausable: !!PAUSABLE[b.id], active: fr?.box === b.id, from: prev !== undefined && v.frames[prev].box === b.id && fr?.box !== b.id, paused: !!w && w.box === b.id && v.live })),
    cur: v.cur, total: n, chat: fr?.chat ?? 0, chats: v.lc.chats.map((c) => ({ n: c.n, title: c.title, first: c.first })), timeline, list,
    detail: v.lc.detailOf(v.cur),
    ...(w && v.live && { paused: { box: w.box, ...pauseHelp(w.point), changes: editSummary(w.edit), target: editTarget(w.point, w.edit), at: w.point.at, ...(w.point.at === "reply" && { calls: callsJson(w.point, w.edit) }), ...(w.point.at === "model" && { tools: w.point.tools, max: w.point.max }), guards: [...GUARDS] } }),
  };
}

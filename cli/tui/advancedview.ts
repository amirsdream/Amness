// Drawing the Advanced view in the terminal: full screen on the canvas (boxes, timeline, frame list, details, all clickable), or as plain lines for the inline interface.
// The state and the actions are in cli/tui/advanced.ts; the desktop draws the same data (advancedData) itself.
import { bold, cyan, dim, gray, green, red, yellow } from "../ui.ts";
import type { Canvas } from "./canvas.ts";
import { BOLD, F, fit } from "./rich.ts";
import { cellWidth, clipWidth, wrapAnsi } from "./text.ts";
import type { Theme } from "./themes.ts";
import { advancedData, type AdvancedView, type PauseBook } from "./advanced.ts";
import { BOXES, type Frame, type Section } from "./lifecycle.ts";

export type AdvHit = { x: number; y: number; w: number; h: number; act: () => void; wheel?: (d: number) => void };

const KEYS_RUN = "←→ frame · [ ] step · PgUp PgDn chat · Tab box · Enter jump · b pause · . pause next · u subagents · f filter · Space play · r replay chat · F fork here · o open · Esc close";
const KEYS_PAUSED = "c go on · n go on, pause at next · e edit · p change… · s skip · d deny · a accept · x discard";

/** The lines of a detail section, wrapped to `w` and coloured by kind (a diff in green and red, JSON dimmed). */
function sectionLines(s: Section, w: number, paint: { add: (x: string) => string; del: (x: string) => string; dim: (x: string) => string; head: (x: string) => string }): string[] {
  const out = [paint.head(s.title)];
  for (const raw of s.body.split("\n").slice(0, 4000)) {
    const l = raw.replace(/\t/g, "  ");
    const colour = s.kind === "diff" ? (l.startsWith("+") && !l.startsWith("+++") ? paint.add : l.startsWith("-") && !l.startsWith("---") ? paint.del : l.startsWith("@@") ? paint.dim : (x: string) => x) : s.kind === "json" ? paint.dim : (x: string) => x;
    for (const part of wrapAnsi(l || " ", Math.max(10, w - 2), 0)) out.push("  " + colour(part));
  }
  out.push("");
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ full screen
export function drawAdvanced(c: Canvas, t: Theme, v: AdvancedView, book: PauseBook): AdvHit[] {
  const W = c.w, H = c.h, d = advancedData(v, book, { around: Math.max(10, H) }), hits: AdvHit[] = [], fr = v.frame;
  const tone = (x: Frame["tone"]) => (x === "err" ? t.err : x === "warn" ? t.warn : x === "ok" ? t.ok : x === "you" ? t.accent2 : t.dim);
  c.clear(t.bg);
  // header
  c.fill(0, 0, W, 1, t.surface);
  const where = d.total ? `chat ${d.chat || "–"}/${d.chats.length} · step ${fr?.step || "–"} · frame ${d.cur + 1}/${d.total}` : "nothing recorded yet";
  const state = d.paused ? F(t.warn, BOLD("⏸ paused")) : d.live ? (d.follow ? F(t.ok, "● live") : F(t.dim, "○ live · End follows")) : F(t.dim, "saved trace");
  c.ansi(1, 0, fit(` ${F(t.accent, "◆")} ${BOLD(F(t.text, "Advanced"))}  ${F(t.dim, clipWidth(d.title, 40))}  ${F(t.border, "│")}  ${F(t.text, where)}  ${F(t.border, "│")}  ${state}${d.next ? F(t.warn, "  · pausing at next point") : ""}${d.filter ? F(t.accent2, `  · only ${d.filter}`) : ""}${d.playing ? F(t.accent, "  ▶ playing") : ""}`, W - 2, t.surface));

  // boxes
  const one = W >= 8 * 9 + 7 * 2 + 2, perRow = one ? 8 : 4, gap = 2, bw = Math.max(9, Math.min(18, Math.floor((W - 2 - (perRow - 1) * gap) / perRow))), bh = 4;
  const rowW = perRow * bw + (perRow - 1) * gap, x0 = Math.max(1, Math.floor((W - rowW) / 2)); let y = 2;
  const centre: Record<string, number> = {};
  d.boxes.forEach((b, i) => {
    const r = Math.floor(i / perRow), col = i % perRow, x = x0 + col * (bw + gap), yy = y + r * (bh + 1);
    centre[b.id] = x + Math.floor(bw / 2);
    const border = b.paused ? t.warn : b.active ? t.accent : b.id === d.focus ? t.borderStrong : t.border, bg = b.active ? t.selection : t.surface;
    c.box(x, yy, bw, bh, { border, bg, style: t.frame });
    c.ansi(x + 1, yy + 1, fit(` ${F(b.active ? t.accent : t.dim, b.glyph)} ${b.active || b.id === d.focus ? BOLD(F(t.text, b.label)) : F(t.text, b.label)}`, bw - 2, bg));
    const mark = b.paused ? F(t.warn, "⏸ waiting") : b.pause ? F(t.warn, b.pause === "once" ? "⏸ once" : "⏸ pause") : b.from ? F(t.accent2, "◀ from") : "";
    c.ansi(x + 1, yy + 2, fit(` ${F(t.faint, b.count ? `${b.count}` : "·")}${mark ? "  " + mark : ""}`, bw - 2, bg));
    if (b.id === d.focus) c.text(x + 1, yy + bh - 1, "▔".repeat(Math.max(0, bw - 2)), { fg: t.accent2, bg: t.bg });
    if (col < perRow - 1 && i < d.boxes.length - 1) c.text(x + bw, yy + 1, " →", { fg: d.boxes[i + 1].active && b.from ? t.accent : t.faint });
    hits.push({ x, y: yy, w: bw, h: bh, act: () => { v.focus = b.id; v.jumpBox(b.id); } });
  });
  y += (one ? 1 : 2) * (bh + 1);
  if (one && centre.model !== undefined && centre.guards !== undefined) {              // the loop: from the guards back to the next model call
    const a = centre.model, z = centre.guards, ly = y - 1;
    c.text(a, ly, "╰", { fg: t.faint }); c.hline(a + 1, ly, z - a - 1, "─", { fg: t.faint }); c.text(z, ly, "╯", { fg: t.faint });
    const label = " ↺ next step "; c.text(a + Math.floor((z - a - label.length) / 2), ly, label, { fg: t.dim });
    y += 0;
  }
  // timeline
  const tw = W - 4, tl = d.timeline, cells = Math.min(tw, tl.length);
  c.text(2, y, "chats", { fg: t.faint }); y++;
  let lastChat = -1;
  for (let k = 0; k < cells; k++) {
    const b = tl[Math.floor((k * tl.length) / cells)], x = 2 + Math.floor((k * tw) / cells), cw = Math.max(1, Math.floor(((k + 1) * tw) / cells) - Math.floor((k * tw) / cells));
    const ch = b.chat !== lastChat ? "┃" : b.tone === "err" ? "█" : b.tone === "warn" ? "▆" : b.tone === "you" ? "▅" : b.tone === "ok" ? "▃" : "▁";
    lastChat = b.chat;
    for (let q = 0; q < cw; q++) c.text(x + q, y, q === 0 ? ch : b.tone === "plain" ? "▁" : ch === "┃" ? "▁" : ch, { fg: ch === "┃" ? t.borderStrong : tone(b.tone) });
    if (b.here) c.text(x, y - 1, "▼", { fg: t.accent });
    hits.push({ x, y, w: cw, h: 1, act: () => v.go(b.at) });
  }
  y += 2;

  // paused band
  if (d.paused) {
    const p = d.paused, rows = [`${F(t.warn, BOLD("⏸ Paused"))} ${F(t.text, p.where)}`, F(t.dim, `you can: ${p.edit}`), ...(p.changes ? [F(t.accent2, `your changes: ${p.changes}`)] : []), F(t.text, KEYS_PAUSED)];
    for (const r of rows) { c.ansi(1, y, fit(" " + r, W - 2, t.surface2)); y++; }
    y++;
  }

  // frame list and details
  const top = y, ph = Math.max(3, H - 1 - top), lw = Math.max(30, Math.min(64, Math.floor(W * 0.42))), dx = lw + 2, dw = W - dx - 1;
  const at = d.list.findIndex((f) => f.i === d.cur), first = Math.max(0, Math.min(at - Math.floor(ph / 2), d.list.length - ph));
  d.list.slice(first, first + ph).forEach((f, k) => {
    const on = f.i === d.cur, bg = on ? t.selection : t.bg, bx = BOXES.find((b) => b.id === f.box)!;
    const line = ` ${F(t.faint, String(f.i + 1).padStart(4))} ${F(tone(f.tone), bx.glyph)} ${on ? BOLD(F(t.text, f.title)) : F(t.text, f.title)}  ${F(t.dim, f.summary)}`;
    c.ansi(0, top + k, fit(line, lw, bg)); hits.push({ x: 0, y: top + k, w: lw, h: 1, act: () => v.go(f.i), wheel: (dd) => { v.move(dd > 0 ? 1 : -1); } });
  });
  for (let k = 0; k < ph; k++) c.text(lw, top + k, "│", { fg: t.border });
  const paint = { add: (x: string) => F(t.addFg, x), del: (x: string) => F(t.delFg, x), dim: (x: string) => F(t.dim, x), head: (x: string) => BOLD(F(t.accent, x)) };
  const lines = d.detail.flatMap((s) => sectionLines(s, dw, paint)); v.scroll = Math.max(0, Math.min(v.scroll, Math.max(0, lines.length - ph)));
  lines.slice(v.scroll, v.scroll + ph).forEach((l, k) => c.ansi(dx, top + k, l, {}, dw));
  if (!d.total) c.ansi(dx, top, F(t.dim, d.live ? "Send a message: every step of the run shows up here as it happens." : "This trace is empty."), {}, dw);
  hits.push({ x: dx, y: top, w: dw, h: ph, act: () => {}, wheel: (dd) => { v.scroll = Math.max(0, v.scroll + dd * 3); } });
  if (lines.length > ph) c.text(W - 1, top + Math.floor((v.scroll / Math.max(1, lines.length - ph)) * (ph - 1)), "┃", { fg: t.borderStrong });

  // footer
  c.fill(0, H - 1, W, 1, t.surface);
  c.ansi(1, H - 1, fit(F(t.dim, d.paused ? KEYS_PAUSED + " · " + KEYS_RUN : KEYS_RUN), W - 2, t.surface));
  return hits;
}

// ------------------------------------------------------------------------------------------------------------------ inline
export function advancedLines(v: AdvancedView, book: PauseBook, w: number, h: number): string[] {
  const d = advancedData(v, book, { around: 4 }), fr = v.frame, out: string[] = [];
  out.push(gray("─".repeat(w)));
  out.push(clipWidth(`${cyan("◆")} ${bold("Advanced")} ${dim(clipWidth(d.title, 30))} ${dim("·")} ${d.total ? `chat ${d.chat}/${d.chats.length} · step ${fr?.step || "–"} · frame ${d.cur + 1}/${d.total}` : dim("nothing recorded yet")}${d.paused ? "  " + yellow(bold("⏸ paused")) : d.live && d.follow ? "  " + green("● live") : ""}`, w));
  out.push(clipWidth(d.boxes.map((b) => { const label = `${b.glyph} ${b.label}${b.count ? " " + b.count : ""}${b.pause ? "⏸" : ""}`; return b.paused ? yellow(bold(`[${label}]`)) : b.active ? cyan(bold(`[${label}]`)) : b.id === d.focus ? bold(label) : dim(label); }).join(dim(" › ")), w));
  const cells = Math.min(w - 2, d.timeline.length);
  if (cells) out.push(" " + Array.from({ length: cells }, (_, k) => { const b = d.timeline[Math.floor((k * d.timeline.length) / cells)]; const ch = b.here ? "▼" : b.tone === "err" ? "█" : b.tone === "warn" ? "▆" : b.tone === "you" ? "▅" : b.tone === "ok" ? "▃" : "▁"; return b.here ? cyan(ch) : b.tone === "err" ? red(ch) : b.tone === "warn" ? yellow(ch) : b.tone === "ok" ? green(ch) : dim(ch); }).join(""));
  if (d.paused) { out.push(yellow(bold("⏸ Paused ")) + d.paused.where, dim(clipWidth(`you can: ${d.paused.edit}`, w))); if (d.paused.changes) out.push(cyan(clipWidth(`your changes: ${d.paused.changes}`, w))); }
  const paint = { add: green, del: red, dim, head: (x: string) => bold(cyan(x)) };
  const lines = d.detail.flatMap((s) => sectionLines(s, w, paint)), room = Math.max(3, h - out.length - 2);
  v.scroll = Math.max(0, Math.min(v.scroll, Math.max(0, lines.length - room)));
  out.push(...lines.slice(v.scroll, v.scroll + room).map((l) => (cellWidth(l) > w ? clipWidth(l, w) : l)));
  out.push(dim(clipWidth(d.paused ? KEYS_PAUSED : KEYS_RUN, w)));
  return out;
}

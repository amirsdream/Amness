// Modal dialogs for the full-screen UI: a dimmed backdrop, a shadowed card, real previews, clickable choices.
import { A, mix } from "./ansi.ts";
import type { Canvas } from "./canvas.ts";
import { renderDiffRows, langOf } from "./diffview.ts";
import { renderMarkdown, highlightWith } from "./markdown.ts";
import { ChoiceOverlay, InputOverlay, PickerOverlay, TextOverlay, type Overlay } from "./overlays.ts";
import { BOLD, F, chip, fit, split, themeSkin } from "./rich.ts";
import { cellWidth, clipWidth, wrapAnsi } from "./text.ts";
import type { Theme } from "./themes.ts";

export type ModalHit = { x: number; y: number; w: number; h: number; kind: "option" | "item" | "scrollup" | "scrolldown"; index: number };
export type ModalResult = { hits: ModalHit[]; cursor?: { x: number; y: number }; box: { x: number; y: number; w: number; h: number } };

/** Draw whichever overlay is active as a centered modal. Returns clickable regions. */
export function drawModal(c: Canvas, t: Theme, o: Overlay, frame: number): ModalResult | undefined {
  const dimTo = t.bg === -1 ? 0x000000 : t.bg;
  const card = (w: number, h: number, border: number, title?: string, icon?: string) => {
    const x = Math.floor((c.w - w) / 2), y = Math.max(1, Math.floor((c.h - h) / 2.2));
    c.dim(0, 0, c.w, c.h, 0.62, dimTo, t.text === -1 ? 0xdddddd : t.text, t.bg === -1 ? 0x101010 : t.bg);
    c.fill(x + 1, y + 1, w, h, mix(t.bg === -1 ? 0x101010 : t.bg, 0x000000, 0.55));        // soft shadow
    c.box(x, y, w, h, { border, bg: t.surface, style: "round" });
    if (title) c.ansi(x + 2, y, " " + (icon ? F(border, icon) + " " : "") + BOLD(F(t.text, title)) + " ", {}, w - 4);
    return { x, y };
  };
  const hits: ModalHit[] = [];

  if (o instanceof ChoiceOverlay) {
    const w = Math.min(c.w - 6, 100), inner = w - 4, d = o.detail;
    const tone = o.title.startsWith("Run") && d?.kind === "command" && d.danger ? t.warn : d?.kind === "plan" ? t.accent2 : t.accent;
    const rows: string[] = [];
    if (d?.kind === "diff") {
      const r = renderDiffRows(d.diff, { width: inner, theme: t, lang: langOf(d.path), mode: "stacked", maxRows: 14 });
      rows.push(...r.rows); if (r.hidden) rows.push(fit(F(t.faint, ` … ${r.hidden} more lines`), inner, t.surface2));
    } else if (d?.kind === "command") {
      rows.push(fit(" " + F(t.accent, "$ ") + BOLD(F(t.text, clipWidth(d.cmd, inner - 5))), inner, t.surface2));
      if (d.cmd.length > inner - 5) for (const l of wrapAnsi(F(t.dim, d.cmd.slice(inner - 5)), inner - 4, 0).slice(0, 4)) rows.push(fit("   " + l, inner, t.surface2));
      if (d.danger) rows.push(fit(" " + F(t.warn, "⚠ " + d.danger), inner, t.surface2));
    } else if (d?.kind === "plan") {
      for (const l of renderMarkdown(d.md, inner - 2, themeSkin(t)).slice(0, 16)) rows.push(fit(" " + l, inner, t.surface));
    } else for (const l of o.body.slice(0, 12)) rows.push(fit(" " + l, inner, t.surface));
    const h = Math.min(c.h - 4, rows.length + o.options.length + 6);
    const { x, y } = card(w, h, tone, o.title, d?.kind === "diff" ? "✎" : d?.kind === "command" ? "❯" : d?.kind === "plan" ? "☰" : "?");
    let yy = y + 1;
    for (const r of rows.slice(0, h - o.options.length - 5)) { c.ansi(x + 2, yy++, r, { bg: t.surface }, inner); }
    yy++;
    c.ansi(x + 2, yy++, BOLD(F(t.text, o.question)), { bg: t.surface }, inner);
    o.options.forEach((opt, i) => {
      const on = i === o.sel, bg = on ? t.selection : t.surface;
      c.ansi(x + 2, yy, fit((on ? F(tone, "▶ ") : "  ") + F(on ? tone : t.faint, `${i + 1}`) + "  " + (on ? BOLD(F(t.text, opt.label)) : F(t.text, opt.label)) + (opt.hint ? "  " + F(t.faint, opt.hint) : ""), inner, bg));
      hits.push({ x: x + 2, y: yy, w: inner, h: 1, kind: "option", index: i }); yy++;
    });
    c.ansi(x + 2, y + h - 2, F(t.faint, "↑↓ choose  ·  enter confirm  ·  1-9 quick pick  ·  esc cancel"), { bg: t.surface }, inner);
    return { hits, box: { x, y, w, h } };
  }

  if (o instanceof PickerOverlay) {
    const list = o.visible(), w = Math.min(c.w - 8, 84), inner = w - 4, maxRows = Math.max(3, Math.min(14, c.h - 10, list.length || 1));
    o.sel = Math.max(0, Math.min(o.sel, list.length - 1));
    const top = Math.max(0, Math.min(o.sel - Math.floor(maxRows / 2), list.length - maxRows)), shown = list.slice(top, top + maxRows);
    const h = shown.length + 6, { x, y } = card(w, h, t.accent, o.title, "⌘");
    const field = fit(" " + F(t.accent, "›") + " " + (o.filter ? F(t.text, o.filter) : F(t.faint, "type to filter…")) + F(t.accent, "▌"), inner, t.surface2);
    c.ansi(x + 2, y + 1, split(field.replace(/\s+$/, ""), "", inner, t.surface2), {}, inner);
    c.ansi(x + 2 + inner - 12, y + 1, fit(F(t.faint, `${list.length}/${o.items.length}`.padStart(11)), 12, t.surface2));
    shown.forEach((it, i) => {
      const idx = top + i, on = idx === o.sel, bg = on ? t.selection : t.surface, yy = y + 3 + i;
      c.ansi(x + 2, yy, split((on ? F(t.accent, "▌ ") : "  ") + (on ? BOLD(F(t.text, clipWidth(it.label, inner - 30))) : F(t.text, clipWidth(it.label, inner - 30))), it.hint ? F(t.faint, clipWidth(it.hint, Math.max(8, inner - 34))) + " " : "", inner, bg));
      hits.push({ x: x + 2, y: yy, w: inner, h: 1, kind: "item", index: idx });
    });
    if (!shown.length) c.ansi(x + 2, y + 3, F(t.faint, "  no matches"), { bg: t.surface }, inner);
    if (top > 0) c.ansi(x + w - 10, y + 2, F(t.faint, `↑ ${top} more`), { bg: t.surface });
    if (top + maxRows < list.length) c.ansi(x + w - 12, y + h - 3, F(t.faint, `↓ ${list.length - top - maxRows} more`), { bg: t.surface });
    c.ansi(x + 2, y + h - 2, F(t.faint, "↑↓ move  ·  enter select  ·  esc cancel  ·  click to choose"), { bg: t.surface }, inner);
    return { hits, box: { x, y, w, h }, cursor: { x: x + 5 + cellWidth(o.filter), y: y + 1 } };
  }

  if (o instanceof InputOverlay) {
    const w = Math.min(c.w - 8, 72), inner = w - 4, h = 7, { x, y } = card(w, h, t.accent, undefined);
    c.ansi(x + 2, y + 1, BOLD(F(t.text, o.prompt.length > inner ? o.prompt.slice(0, inner - 1) + "…" : o.prompt)), { bg: t.surface }, inner);
    const shown = o.secret ? "•".repeat(o.ed.text.length) : o.ed.text.split("\n")[0];
    c.box(x + 2, y + 2, inner, 3, { border: t.accent, bg: t.surface2, style: "round" });
    c.ansi(x + 4, y + 3, F(t.text, clipWidth(shown, inner - 4)), { bg: t.surface2 }, inner - 4);
    c.ansi(x + 2, y + h - 2, F(t.faint, o.hint), { bg: t.surface }, inner);
    return { hits, box: { x, y, w, h }, cursor: { x: x + 4 + Math.min(cellWidth(shown), inner - 5), y: y + 3 } };
  }

  if (o instanceof TextOverlay) {
    const w = Math.min(c.w - 6, 110), inner = w - 4, visible = Math.min(o.lines.length, c.h - 8), h = visible + 4, { x, y } = card(w, h, t.accent2, "Help", "?");
    const maxScroll = Math.max(0, o.lines.length - visible); o.scroll = Math.max(0, Math.min(o.scroll, maxScroll));
    o.lines.slice(o.scroll, o.scroll + visible).forEach((l, i) => c.ansi(x + 2, y + 1 + i, fit(l, inner, t.surface), {}, inner));
    c.ansi(x + 2, y + h - 2, F(t.faint, (maxScroll ? "↑↓ scroll  ·  " : "") + "any other key closes"), { bg: t.surface }, inner);
    return { hits, box: { x, y, w, h } };
  }
  void A; void highlightWith; void chip; void frame;
  return undefined;
}

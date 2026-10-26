// Row-building helpers and the themed markdown skin for the full-screen UI.
// Convention: helpers reset only what they set (fg -> 39, bg -> 49, bold -> 22), so a row can carry one background across many styled spans.
import { bgSeq, fgSeq } from "./ansi.ts";
import { highlightWith, type HlKind, type Skin } from "./markdown.ts";
import { cellWidth, clipAnsi, strip, wrapAnsi } from "./text.ts";
import type { Theme } from "./themes.ts";

export const F = (c: number, s: string) => (s ? fgSeq(c) + s + "\x1b[39m" : s);
export const B = (c: number, s: string) => (s ? bgSeq(c) + s + "\x1b[49m" : s);
export const BOLD = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const DIMM = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const ITAL = (s: string) => `\x1b[3m${s}\x1b[23m`;
export const UNDER = (s: string) => `\x1b[4m${s}\x1b[24m`;
export const STRIKE = (s: string) => `\x1b[9m${s}\x1b[29m`;

/** Make `content` exactly `width` columns: clip if longer, pad with spaces on background `bg` if shorter. */
export function fit(content: string, width: number, bg: number): string {
  const w = cellWidth(content), b = bgSeq(bg);
  const c = (w > width ? clipAnsi(content, width) : content).replace(/\x1b\[49m/g, b).replace(/\x1b\[0m/g, "\x1b[0m" + b);   // inner resets must fall back to the ROW background, not the terminal's
  return b + c + b + " ".repeat(Math.max(0, width - Math.min(w, width))) + "\x1b[49m";
}
/** Left part, flexible gap, right part, all on one background. */
export function split(left: string, right: string, width: number, bg: number): string {
  const gap = width - cellWidth(left) - cellWidth(right);
  return gap >= 1 ? fit(left + " ".repeat(gap) + right, width, bg) : fit(left, width, bg);
}
/** A small pill: padded text on its own background. */
export const chip = (text: string, fg: number, bg: number, bold = false) => bgSeq(bg) + fgSeq(fg) + (bold ? "\x1b[1m" : "") + ` ${text} ` + (bold ? "\x1b[22m" : "") + "\x1b[39m\x1b[49m";

export function themeSkin(t: Theme): Skin {
  const hl = (k: HlKind, s: string) => (k === "plain" ? F(t.syn.plain, s) : F(t.syn[k === "keyword" ? "keyword" : k === "string" ? "string" : k === "number" ? "number" : "comment"], k === "comment" ? ITAL(s) : s));
  const skin: Skin = {
    bold: BOLD, italic: ITAL, strike: STRIKE, dim: (s) => F(t.dim, s),
    code: (s) => B(t.inlineCodeBg, F(t.inlineCode, ` ${s} `)),
    link: (text, url) => F(t.link, UNDER(text)) + F(t.faint, ` ${url}`),
    heading(level, text, width) {
      if (level === 1) return [BOLD(F(t.accent, strip(text).toUpperCase() === strip(text) ? text : text)), F(t.border, "━".repeat(Math.min(width, Math.max(10, cellWidth(strip(text))))))];
      if (level === 2) return [BOLD(F(t.accent2, text)), F(t.border, "─".repeat(Math.min(width, Math.max(8, cellWidth(strip(text))))))];
      return [BOLD(F(t.text, text))];
    },
    quote: (inner) => F(t.accent, "▎ ") + ITAL(F(t.dim, inner)),
    bullet: (m) => F(t.accent, m),
    hr: (w) => F(t.border, "─".repeat(Math.min(w, 72))),
    hl,
    codeBlock(body, lang, width) {
      const out: string[] = [], inner = width - 4;
      const head = split(" " + F(t.dim, (lang || "text").toLowerCase()), F(t.faint, "copy "), width, t.surface2);
      out.push(head);
      for (const b of body.length ? body : [""]) {
        const styled = lang === "diff" ? (b.startsWith("+") ? F(t.addFg, b) : b.startsWith("-") ? F(t.delFg, b) : b.startsWith("@@") ? F(t.accent2, b) : F(t.dim, b)) : highlightWith(b, lang, hl);
        const rows = wrapAnsi(styled, inner, 2);
        for (const r of rows) out.push(fit("  " + r, width, t.surface));
      }
      out.push(fit("", width, t.surface));
      return out;
    },
    table(rows, width) {
      const n = Math.max(...rows.map((r) => r.length)), cellOf = (s: string) => inlineCell(s, skin);
      const widths = Array.from({ length: n }, (_, i) => Math.max(...rows.map((r) => cellWidth(cellOf(r[i] ?? "")))));
      if (widths.reduce((a, b) => a + b, 0) + 3 * n + 1 > width) return rows.map((r, i) => (i === 0 ? BOLD(r.join(" │ ")) : r.join(" │ ")));
      const v = F(t.border, "│"), rule = (l: string, m: string, r: string) => F(t.border, l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
      const line = (r: string[], head: boolean) => {
        const cells = widths.map((w, i) => { const c = cellOf(r[i] ?? ""); return " " + (head ? BOLD(F(t.accent2, c)) : c) + " ".repeat(w - cellWidth(c)) + " "; });
        return v + cells.map((c) => (head ? B(t.surface2, c) : c)).join(v) + v;
      };
      return [rule("╭", "┬", "╮"), line(rows[0], true), rule("├", "┼", "┤"), ...rows.slice(1).map((r) => line(r, false)), rule("╰", "┴", "╯")];
    },
  };
  return skin;
}
import { inline } from "./markdown.ts";
const inlineCell = (s: string, skin: Skin) => inline(s, skin);

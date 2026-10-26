// A character-cell canvas. Draw into it freely, then `flush()` emits only the cells that changed since the last frame
// (inside synchronized-output markers), which is what makes a full-screen UI flicker-free and cheap over SSH.
import { A, DEFAULT, mix, parseAnsi, sgrFor, toRgb, type Cell } from "./ansi.ts";
import { cpWidth } from "./text.ts";

export type Style = { fg?: number; bg?: number; attr?: number };
export const BORDERS = {
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  square: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  thick: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
} as const;

/** Reduce a 24-bit colour to what the terminal can show. level: 3 truecolor, 2 = 256 colours, 1 = 16 colours, 0 = none. */
export function quantize(c: number, level: 0 | 1 | 2 | 3, isBg = false): number {
  if (c === DEFAULT || level === 0 || c >= 0x1000000) return level === 0 ? DEFAULT : c;
  if (level === 3) return c;
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  if (level === 2) {
    if (Math.abs(r - g) < 9 && Math.abs(g - b) < 9) { const v = Math.round(((r + g + b) / 3 - 8) / 10); return 0x1000000 + (v < 0 ? 16 : v > 23 ? 231 : 232 + v); }
    const q = (x: number) => Math.round((x / 255) * 5);
    return 0x1000000 + 16 + 36 * q(r) + 6 * q(g) + q(b);
  }
  const bright = Math.max(r, g, b) > (isBg ? 230 : 190), idx = (r > 127 ? 1 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 4 : 0);
  return 0x1000000 + (bright && !isBg ? 8 : 0) + (idx === 0 && !bright ? 0 : idx || 7);
}

export class Canvas {
  w: number; h: number;
  ch: string[]; fg: Int32Array; bg: Int32Array; attr: Uint8Array;
  private prev?: { ch: string[]; fg: Int32Array; bg: Int32Array; attr: Uint8Array };
  cursor: { x: number; y: number } | null = null;
  level: 0 | 1 | 2 | 3 = 3;
  defaultBg: number;

  constructor(w: number, h: number, defaultBg = DEFAULT) {
    this.w = w; this.h = h; this.defaultBg = defaultBg;
    this.ch = new Array(w * h).fill(" "); this.fg = new Int32Array(w * h).fill(DEFAULT); this.bg = new Int32Array(w * h).fill(defaultBg); this.attr = new Uint8Array(w * h);
  }
  private i(x: number, y: number) { return y * this.w + x; }
  inside(x: number, y: number) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  clear(bg = this.defaultBg, fg = DEFAULT) { this.ch.fill(" "); this.fg.fill(fg); this.bg.fill(bg); this.attr.fill(0); }
  /** Fill a rectangle with a background (and optionally a glyph). */
  fill(x: number, y: number, w: number, h: number, bg: number, ch = " ", fg = DEFAULT) {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) { this.breakGlyph(xx, yy); const i = this.i(xx, yy); this.ch[i] = ch; this.bg[i] = bg; this.fg[i] = fg; this.attr[i] = 0; }
  }
  /** Blank whatever wide glyph occupies cell (x,y) (either half), so no orphaned half is left behind. */
  private breakGlyph(x: number, y: number) {
    const i = this.i(x, y);
    if (this.ch[i] === "" && x > 0) this.ch[i - 1] = " ";                     // overwriting the right half destroys the glyph
    if (x + 1 < this.w && this.ch[i + 1] === "") this.ch[i + 1] = " ";          // overwriting the left half orphans the right half
  }
  setCell(x: number, y: number, c: Cell, keepBg = false) {
    if (!this.inside(x, y)) return;
    if (c.w === 2 && x + 1 >= this.w) { c = { ...c, ch: " ", w: 1 }; }          // a wide glyph never straddles the edge
    this.breakGlyph(x, y); if (c.w === 2) this.breakGlyph(x + 1, y);
    const i = this.i(x, y);
    this.ch[i] = c.ch; this.fg[i] = c.fg; this.attr[i] = c.attr; if (!keepBg || c.bg !== DEFAULT) this.bg[i] = c.bg;
    if (c.w === 2) { const j = i + 1; this.ch[j] = ""; this.fg[j] = c.fg; this.bg[j] = this.bg[i]; this.attr[j] = c.attr; }
  }
  /** Draw styled cells; returns the width used. Cells with the default background keep what is underneath. */
  put(x: number, y: number, cells: Cell[], maxW = this.w - x): number {
    let used = 0;
    for (const c of cells) { if (used + c.w > maxW) break; this.setCell(x + used, y, c, true); used += c.w; }
    return used;
  }
  /** Draw a plain string with one style. */
  text(x: number, y: number, s: string, st: Style = {}, maxW = this.w - x): number {
    const cells: Cell[] = [];
    for (const g of s) { const w = cpWidth(g.codePointAt(0)!); if (w === 0) continue; cells.push({ ch: g, w, fg: st.fg ?? DEFAULT, bg: st.bg ?? DEFAULT, attr: st.attr ?? 0 }); }
    return this.put(x, y, cells, maxW);
  }
  /** Draw an ANSI string (as produced by the renderers). */
  ansi(x: number, y: number, s: string, base: Style = {}, maxW = this.w - x): number { return this.put(x, y, parseAnsi(s, base), maxW); }

  hline(x: number, y: number, w: number, ch: string, st: Style) { for (let k = 0; k < w; k++) this.text(x + k, y, ch, st); }
  /** A bordered box; the interior is filled with `bg`. A title sits in the top border. */
  box(x: number, y: number, w: number, h: number, o: { border?: number; bg?: number; style?: keyof typeof BORDERS; title?: string; titleFg?: number; titleBg?: number } = {}) {
    const b = BORDERS[o.style ?? "round"], st = { fg: o.border ?? DEFAULT, bg: o.bg ?? DEFAULT };
    if (w < 2 || h < 2) return;
    if (o.bg !== undefined) this.fill(x, y, w, h, o.bg);
    this.text(x, y, b.tl + b.h.repeat(w - 2) + b.tr, st); this.text(x, y + h - 1, b.bl + b.h.repeat(w - 2) + b.br, st);
    for (let yy = y + 1; yy < y + h - 1; yy++) { this.text(x, yy, b.v, st); this.text(x + w - 1, yy, b.v, st); }
    if (o.title) this.text(x + 2, y, ` ${o.title} `, { fg: o.titleFg ?? o.border, bg: o.titleBg ?? o.bg, attr: A.bold }, w - 4);
  }
  /** Fade everything inside a rectangle toward `toward` (modal backdrop). */
  dim(x: number, y: number, w: number, h: number, t: number, toward: number, defFg: number, defBg: number) {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) {
      const i = this.i(xx, yy);
      this.fg[i] = mix(toRgb(this.fg[i], defFg), toward, t); this.bg[i] = mix(toRgb(this.bg[i], defBg), toward, t * 0.8);
    }
  }
  /** Tint the background of a rectangle (selection, hover). */
  tint(x: number, y: number, w: number, h: number, bg: number) { for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.bg[this.i(xx, yy)] = bg; }

  /** Text of a row range (for copy), trailing spaces trimmed. */
  readRow(y: number, x0 = 0, x1 = this.w): string { let s = ""; for (let x = x0; x < x1; x++) s += this.ch[this.i(x, y)]; return s.replace(/\s+$/, ""); }

  /** Emit the minimal escape sequence that turns the previous frame into this one. `full` repaints everything. */
  flush(full = false): string {
    for (let i = 0; i < this.ch.length; i++) if (this.ch[i] === "" && i % this.w > 0) { this.bg[i] = this.bg[i - 1]; this.fg[i] = this.fg[i - 1]; this.attr[i] = this.attr[i - 1]; }
    const prev = full ? undefined : this.prev;
    let out = "", lastFg = -2, lastBg = -2, lastAttr = -1, penX = -1, penY = -1;
    const q = (c: number, bg: boolean) => quantize(c, this.level, bg);
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const i = this.i(x, y);
        if (prev && prev.ch[i] === this.ch[i] && prev.fg[i] === this.fg[i] && prev.bg[i] === this.bg[i] && prev.attr[i] === this.attr[i]) { x++; continue; }
        if (this.ch[i] === "") { x++; continue; }                                    // second half of a wide character
        if (x !== penX || y !== penY) out += `\x1b[${y + 1};${x + 1}H`;
        const f = q(this.fg[i], false), b = q(this.bg[i], true), a = this.attr[i];
        if (f !== lastFg || b !== lastBg || a !== lastAttr) { out += sgrFor(f, b, a); lastFg = f; lastBg = b; lastAttr = a; }
        out += this.ch[i];
        const w = x + 1 < this.w && this.ch[i + 1] === "" ? 2 : 1;
        x += w; penX = x; penY = y;
      }
    }
    if (out) out += "\x1b[0m";
    this.prev = { ch: this.ch.slice(), fg: this.fg.slice(), bg: this.bg.slice(), attr: this.attr.slice() };
    return out;
  }
  /** Forget what is on the terminal (after a resize or an external clear) so the next flush repaints everything. */
  invalidate() { this.prev = undefined; }
}

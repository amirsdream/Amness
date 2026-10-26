// ANSI strings <-> styled cells. The renderers produce ANSI strings; the full-screen canvas and the screenshot tool need cells.
import { cpWidth } from "./text.ts";

/** Colour: -1 = terminal default, 0x000000..0xFFFFFF = truecolor, 0x1000000 + n = 256-palette index n. */
export const DEFAULT = -1;
export const A = { bold: 1, dim: 2, italic: 4, underline: 8, strike: 16, inverse: 32 } as const;
export type Cell = { ch: string; w: number; fg: number; bg: number; attr: number };

const BASE16 = [0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff];
/** Resolve any colour value to 0xRRGGBB (for dimming/compositing and for screenshots). `def` stands in for the terminal default. */
export function toRgb(c: number, def: number): number {
  if (c === DEFAULT) return def;
  if (c < 0x1000000) return c;
  const i = c - 0x1000000;
  if (i < 16) return BASE16[i];
  if (i >= 232) { const v = 8 + (i - 232) * 10; return (v << 16) | (v << 8) | v; }
  const n = i - 16, lv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return (lv(Math.floor(n / 36)) << 16) | (lv(Math.floor(n / 6) % 6) << 8) | lv(n % 6);
}
export const rgb = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
export const mix = (a: number, b: number, t: number) => rgb(...[16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)) as [number, number, number]);

type St = { fg: number; bg: number; attr: number };

/** Apply the parameters of one SGR sequence (the part between `ESC[` and `m`) to a style. */
export function applySgr(st: St, params: string): void {
  const p = params === "" ? [0] : params.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) { st.fg = DEFAULT; st.bg = DEFAULT; st.attr = 0; }
    else if (n === 1) st.attr |= A.bold; else if (n === 2) st.attr |= A.dim; else if (n === 3) st.attr |= A.italic; else if (n === 4) st.attr |= A.underline;
    else if (n === 7) st.attr |= A.inverse; else if (n === 9) st.attr |= A.strike;
    else if (n === 22) st.attr &= ~(A.bold | A.dim); else if (n === 23) st.attr &= ~A.italic; else if (n === 24) st.attr &= ~A.underline; else if (n === 27) st.attr &= ~A.inverse; else if (n === 29) st.attr &= ~A.strike;
    else if (n >= 30 && n <= 37) st.fg = 0x1000000 + n - 30; else if (n >= 90 && n <= 97) st.fg = 0x1000000 + n - 90 + 8; else if (n === 39) st.fg = DEFAULT;
    else if (n >= 40 && n <= 47) st.bg = 0x1000000 + n - 40; else if (n >= 100 && n <= 107) st.bg = 0x1000000 + n - 100 + 8; else if (n === 49) st.bg = DEFAULT;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg";
      if (p[i + 1] === 2) { st[key] = rgb(p[i + 2] & 255, p[i + 3] & 255, p[i + 4] & 255); i += 4; }
      else if (p[i + 1] === 5) { st[key] = 0x1000000 + (p[i + 2] & 255); i += 2; }
    }
  }
}

/** Parse an ANSI string into styled cells. Wide characters become one cell with w = 2. Unknown escape sequences are dropped. */
export function parseAnsi(s: string, base: Partial<St> = {}): Cell[] {
  const st: St = { fg: base.fg ?? DEFAULT, bg: base.bg ?? DEFAULT, attr: base.attr ?? 0 }, out: Cell[] = [];
  const re = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([\s\S])/gu;
  for (let m; (m = re.exec(s)); ) {
    if (m[2] === "m") { const b = { ...base }; applySgr(st, m[1]); void b; }
    else if (m[3] !== undefined) {
      const cp = m[3].codePointAt(0)!, w = cpWidth(cp);
      if (w === 0) { if (out.length && cp >= 0x300) out[out.length - 1].ch += m[3]; continue; }     // combining marks join the previous cell
      out.push({ ch: m[3], w, fg: st.fg, bg: st.bg, attr: st.attr });
    }
  }
  return out;
}

/** Cells back to an ANSI string (minimal SGR changes). */
export function cellsToAnsi(cells: Cell[]): string {
  let out = "", fg = DEFAULT, bg = DEFAULT, attr = 0;
  for (const c of cells) {
    if (c.fg !== fg || c.bg !== bg || c.attr !== attr) { out += sgrFor(c.fg, c.bg, c.attr); fg = c.fg; bg = c.bg; attr = c.attr; }
    out += c.ch;
  }
  return out + (fg !== DEFAULT || bg !== DEFAULT || attr ? "\x1b[0m" : "");
}

const colorSeq = (c: number, base: 30 | 40) => (c === DEFAULT ? String(base + 9) : c >= 0x1000000 ? (c - 0x1000000 < 8 ? String(base + c - 0x1000000) : c - 0x1000000 < 16 ? String(base + 60 + c - 0x1000000 - 8) : `${base + 8};5;${c - 0x1000000}`) : `${base + 8};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
/** Full SGR (reset + everything) to reach a given style from any state. */
export function sgrFor(fg: number, bg: number, attr: number): string {
  const p = ["0"];
  if (attr & A.bold) p.push("1"); if (attr & A.dim) p.push("2"); if (attr & A.italic) p.push("3"); if (attr & A.underline) p.push("4"); if (attr & A.inverse) p.push("7"); if (attr & A.strike) p.push("9");
  if (fg !== DEFAULT) p.push(colorSeq(fg, 30)); if (bg !== DEFAULT) p.push(colorSeq(bg, 40));
  return `\x1b[${p.join(";")}m`;
}

/** SGR fragments for a colour (truecolor, 256-palette index, or default). */
export const fgSeq = (c: number) => (c === DEFAULT ? "\x1b[39m" : c >= 0x1000000 ? `\x1b[38;5;${c - 0x1000000}m` : `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`);
export const bgSeq = (c: number) => (c === DEFAULT ? "\x1b[49m" : c >= 0x1000000 ? `\x1b[48;5;${c - 0x1000000}m` : `\x1b[48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`);

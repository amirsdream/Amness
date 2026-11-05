// Terminal text primitives: ANSI stripping, display width (wide chars / emoji), and ANSI-aware wrapping.
export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const EMOJI = /\p{Emoji_Presentation}/u, PICT = /\p{Extended_Pictographic}/u;
/** Columns a single code point occupies. */
export function cpWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x200d) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  if (cp >= 0x231a && EMOJI.test(String.fromCodePoint(cp))) return 2;          // ✅ ⌚ ⭐ 🫠: emoji drawn wide by default
  return 1;
}

// One character as the terminal draws it can be several code points: 👨‍👩‍👧 (joined), 👍🏽 (skin tone), 🇩🇪 (flag), ☺️ (emoji style), é (e + accent).
// Measuring those code point by code point overcounts and shifts borders and the cursor; they are measured as one grapheme instead.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const CLUSTERS = /[\u0300-\u036f\u200d\ufe0f\u20d0-\u20ff\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;
/** The characters of a string as drawn (graphemes). Plain text takes the fast path: one code point each. */
export function graphemes(s: string): string[] {
  return CLUSTERS.test(s) ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}
/** Columns one grapheme occupies. */
export function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0)!;
  if (g.length === (cp > 0xffff ? 2 : 1)) return cpWidth(cp);
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;                                  // a flag: two regional indicators
  if (PICT.test(String.fromCodePoint(cp)) && (g.includes("\u200d") || g.includes("\ufe0f") || /[\u{1F3FB}-\u{1F3FF}]/u.test(g))) return 2;
  return cpWidth(cp);
}
const ESC_SPLIT = /(\x1b\[[0-9;?]*[A-Za-z])/;
/** An ANSI string as escape codes and graphemes, in order. */
export function tokens(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(ESC_SPLIT)) { if (!part) continue; if (part.charCodeAt(0) === 27 && part.length > 1) out.push(part); else out.push(...graphemes(part)); }
  return out;
}

/** Display width of a string (ANSI codes ignored). */
export function cellWidth(s: string): number {
  const t = strip(s);
  if (/^[\x20-\x7e]*$/.test(t)) return t.length;
  let w = 0;
  for (const g of graphemes(t)) w += graphemeWidth(g);
  return w;
}

/** Cut a plain string to at most `max` columns. */
export function clipWidth(s: string, max: number): string {
  let w = 0, out = "";
  for (const ch of graphemes(s)) { const cw = graphemeWidth(ch); if (w + cw > max) break; out += ch; w += cw; }
  return out;
}

/**
 * Word-wrap one logical line (may contain ANSI codes) to `width` columns. Continuation lines get `indent` spaces.
 * Words longer than the width are hard-cut. Styles active at a break are re-opened is NOT attempted; each wrapped
 * row ends with a reset so colours never bleed, and the next row restarts plain (callers style before wrapping short spans).
 */
export function wrapAnsi(line: string, width: number, indent = 0): string[] {
  width = Math.max(4, width);
  if (cellWidth(line) <= width) return [line];
  const reset = "\x1b[0m", hasAnsi = line.includes("\x1b");
  const rows: string[] = [];
  let cur = "", vis = 0, lastSpace = -1, lastSpaceVis = 0;
  const pad = " ".repeat(indent);
  for (const tok of tokens(line)) {
    if (tok[0] === "\x1b" && tok.length > 1) { cur += tok; continue; }
    const w = graphemeWidth(tok);
    if (vis + w > width) {
      if (lastSpace > 0) {
        rows.push(cur.slice(0, lastSpace).replace(/\s+$/, "") + (hasAnsi ? reset : ""));
        cur = pad + cur.slice(lastSpace + 1); vis = cellWidth(cur);
      } else {
        rows.push(cur + (hasAnsi ? reset : ""));
        cur = pad; vis = indent;
      }
      lastSpace = -1;
    }
    if (tok === " ") { lastSpace = cur.length; lastSpaceVis = vis; }
    cur += tok; vis += w;
  }
  void lastSpaceVis;
  rows.push(cur);
  return rows;
}

/** Cut an ANSI string to at most `max` columns, keeping escape codes intact and closing any open style. */
export function clipAnsi(line: string, max: number): string {
  if (cellWidth(line) <= max) return line;
  let out = "", w = 0;
  for (const tok of tokens(line)) {
    if (tok[0] === "\x1b" && tok.length > 1) { out += tok; continue; }
    const cw = graphemeWidth(tok);
    if (w + cw > max - 1) break;
    out += tok; w += cw;
  }
  return out + "…" + (line.includes("\x1b") ? "\x1b[0m" : "");
}

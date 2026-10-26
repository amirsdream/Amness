// Terminal text primitives: ANSI stripping, display width (wide chars / emoji), and ANSI-aware wrapping.
export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Columns a single code point occupies. */
export function cpWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x200d) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** Display width of a string (ANSI codes ignored). */
export function cellWidth(s: string): number {
  let w = 0;
  for (const ch of strip(s)) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** Cut a plain string to at most `max` columns. */
export function clipWidth(s: string, max: number): string {
  let w = 0, out = "";
  for (const ch of s) { const cw = cpWidth(ch.codePointAt(0)!); if (w + cw > max) break; out += ch; w += cw; }
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
  for (const tok of line.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) ?? []) {
    if (tok[0] === "\x1b" && tok.length > 1) { cur += tok; continue; }
    const w = cpWidth(tok.codePointAt(0)!);
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
  for (const tok of line.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) ?? []) {
    if (tok[0] === "\x1b" && tok.length > 1) { out += tok; continue; }
    const cw = cpWidth(tok.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += tok; w += cw;
  }
  return out + "…" + (line.includes("\x1b") ? "\x1b[0m" : "");
}

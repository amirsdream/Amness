// Minimal VT100 emulator for tests: enough to replay what Screen writes and assert what a user would actually see.
import { DEFAULT, applySgr, toRgb } from "../../cli/tui/ansi.ts";
import { cpWidth } from "../../cli/tui/text.ts";

export type StyledCell = { ch: string; fg: number; bg: number; attr: number };
const blankCell = (): StyledCell => ({ ch: " ", fg: DEFAULT, bg: DEFAULT, attr: 0 });

export class VTerm {
  cols: number; rows: number;
  grid: string[][]; styles: StyledCell[][]; scrollback: string[] = []; st = { fg: DEFAULT, bg: DEFAULT, attr: 0 };
  r = 0; c = 0; cursorVisible = true; altActive = false; pending = false;
  constructor(cols = 80, rows = 24) { this.cols = cols; this.rows = rows; this.grid = Array.from({ length: rows }, () => this.blank()); this.styles = Array.from({ length: rows }, () => this.blankStyles()); }
  private blankStyles() { return Array.from({ length: this.cols }, blankCell); }
  private blank() { return Array.from({ length: this.cols }, () => " "); }
  private lf() { if (this.r === this.rows - 1) { this.scrollback.push(this.grid.shift()!.join("").replace(/\s+$/, "")); this.grid.push(this.blank()); this.styles.shift(); this.styles.push(this.blankStyles()); } else this.r++; }

  write(s: string) {
    for (let i = 0; i < s.length; ) {
      const ch = s[i];
      if (ch === "\x1b" && s[i + 1] === "]") { const end = s.slice(i).search(/\x07|\x1b\\/); i = end < 0 ? s.length : i + end + (s[i + end] === "\x07" ? 1 : 2); continue; }   // OSC (window title): no visible effect
      if (ch === "\x1b" && s[i + 1] === "[") {
        const m = s.slice(i + 2).match(/^([0-9;?]*)([A-Za-z])/);
        if (!m) { i++; continue; }
        i += 2 + m[0].length; const n = Number(m[1].split(";")[0]) || 0, fin = m[2];
        if (m[1].startsWith("?")) { if (m[1] === "?25") this.cursorVisible = fin === "h"; if (m[1] === "?1049") this.altActive = fin === "h"; continue; }
        this.pending = false;
        if (fin === "A") this.r = Math.max(0, this.r - (n || 1));
        else if (fin === "B") this.r = Math.min(this.rows - 1, this.r + (n || 1));
        else if (fin === "C") this.c = Math.min(this.cols - 1, this.c + (n || 1));
        else if (fin === "D") this.c = Math.max(0, this.c - (n || 1));
        else if (fin === "G") this.c = Math.max(0, Math.min(this.cols - 1, (n || 1) - 1));
        else if (fin === "J") { if (n === 2) { this.grid = Array.from({ length: this.rows }, () => this.blank()); this.styles = Array.from({ length: this.rows }, () => this.blankStyles()); } else { for (let x = this.c; x < this.cols; x++) { this.grid[this.r][x] = " "; this.styles[this.r][x] = { ...blankCell(), bg: this.st.bg }; } for (let y = this.r + 1; y < this.rows; y++) { this.grid[y] = this.blank(); this.styles[y] = this.blankStyles(); } } }
        else if (fin === "K") for (let x = n === 2 ? 0 : this.c; x < this.cols; x++) { this.grid[this.r][x] = " "; this.styles[this.r][x] = { ...blankCell(), bg: this.st.bg }; }
        else if (fin === "m") applySgr(this.st, m[1]);
        else if (fin === "H") { const [pr, pc] = m[1].split(";").map(Number); this.r = Math.min(this.rows - 1, Math.max(0, (pr || 1) - 1)); this.c = Math.min(this.cols - 1, Math.max(0, (pc || 1) - 1)); }
        continue;
      }
      i++;
      if (ch === "\r") { this.c = 0; this.pending = false; }
      else if (ch === "\n") { this.lf(); this.pending = false; }
      else if (ch < " ") continue;
      else {
        const cp = s.codePointAt(i - 1)!, w = cpWidth(cp);
        const g = String.fromCodePoint(cp); if (cp > 0xffff) i++;                          // astral characters are two UTF-16 units
        if (this.pending || this.c + w > this.cols) { this.c = 0; this.lf(); this.pending = false; }   // deferred autowrap, like a real terminal
        this.grid[this.r][this.c] = g; this.styles[this.r][this.c] = { ch: g, fg: this.st.fg, bg: this.st.bg, attr: this.st.attr }; if (w === 2 && this.c + 1 < this.cols) { this.grid[this.r][this.c + 1] = ""; this.styles[this.r][this.c + 1] = { ch: "", fg: this.st.fg, bg: this.st.bg, attr: this.st.attr }; }
        this.c += w; if (this.c >= this.cols) { this.c = this.cols - 1; this.pending = true; }
      }
    }
  }
  /** Visible rows (trailing blanks trimmed). */
  screen(): string[] { const rows = this.grid.map((r) => r.join("").replace(/\s+$/, "")); while (rows.length && !rows.at(-1)) rows.pop(); return rows; }
  /** Everything the user could scroll through: scrollback followed by the visible screen. */
  all(): string[] { return [...this.scrollback, ...this.screen()]; }

  /** The visible screen as styled cells (what a user would see). */
  cells(): StyledCell[][] { return this.styles.map((row, y) => row.map((c, x) => ({ ...c, ch: this.grid[y][x] === "" ? "" : this.grid[y][x] }))); }

  /** Render the screen as an SVG (for visual review: convert with `qlmanage -t -s <px> -o <dir> file.svg`). */
  toSvg(o: { defaultFg?: number; defaultBg?: number; cw?: number; ch?: number; font?: number; square?: boolean } = {}): string {
    const dFg = o.defaultFg ?? 0xd4d4d4, dBg = o.defaultBg ?? 0x1e1e1e, cw = o.cw ?? 8.4, chh = o.ch ?? 17, font = o.font ?? 14;
    const W = Math.ceil(this.cols * cw) + 16, H = Math.ceil(this.rows * chh) + 16, S = o.square === false ? undefined : Math.max(W, H);
    const hex = (c: number) => "#" + c.toString(16).padStart(6, "0"), esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cells = this.cells(); let rects = "", texts = "";
    cells.forEach((row, y) => {
      for (let x = 0; x < row.length; ) {                       // background runs
        const c = row[x], inv = c.attr & 32, bg = toRgb(inv ? c.fg : c.bg, inv ? dFg : dBg); let e = x + 1;
        while (e < row.length && toRgb((row[e].attr & 32) ? row[e].fg : row[e].bg, (row[e].attr & 32) ? dFg : dBg) === bg) e++;
        if (bg !== dBg) rects += `<rect x="${8 + x * cw}" y="${8 + y * chh}" width="${(e - x) * cw + 0.5}" height="${chh + 0.5}" fill="${hex(bg)}"/>`;
        x = e;
      }
      for (let x = 0; x < row.length; ) {                       // text runs with the same style
        const c = row[x]; if (c.ch === "" || c.ch === " ") { x++; continue; }
        const inv = c.attr & 32, fg = toRgb(inv ? c.bg : c.fg, inv ? dBg : dFg); let e = x + 1, txt = c.ch;
        while (e < row.length && row[e].ch !== "" && row[e].attr === c.attr && row[e].fg === c.fg && row[e].bg === c.bg) { txt += row[e].ch; e++; }
        const dim = c.attr & 2 ? ' opacity="0.6"' : "", w = c.attr & 1 ? ' font-weight="bold"' : "", i = c.attr & 4 ? ' font-style="italic"' : "", u = c.attr & 8 ? ' text-decoration="underline"' : "";
        texts += `<text x="${8 + x * cw}" y="${8 + y * chh + chh * 0.78}" fill="${hex(fg)}"${dim}${w}${i}${u} textLength="${(e - x) * cw}" lengthAdjust="spacing" xml:space="preserve">${esc(txt)}</text>`;
        x = e;
      }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S ?? W}" height="${S ?? H}" viewBox="0 0 ${S ?? W} ${S ?? H}"><rect width="100%" height="100%" fill="${hex(dBg)}"/><g font-family="Menlo, 'SF Mono', Monaco, monospace" font-size="${font}">${rects}${texts}</g></svg>`;
  }
}

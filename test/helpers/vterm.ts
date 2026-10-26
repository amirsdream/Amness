// Minimal VT100 emulator for tests: enough to replay what Screen writes and assert what a user would actually see.
import { cpWidth } from "../../cli/tui/text.ts";

export class VTerm {
  cols: number; rows: number;
  grid: string[][]; scrollback: string[] = [];
  r = 0; c = 0; cursorVisible = true; altActive = false; pending = false;
  constructor(cols = 80, rows = 24) { this.cols = cols; this.rows = rows; this.grid = Array.from({ length: rows }, () => this.blank()); }
  private blank() { return Array.from({ length: this.cols }, () => " "); }
  private lf() { if (this.r === this.rows - 1) { this.scrollback.push(this.grid.shift()!.join("").replace(/\s+$/, "")); this.grid.push(this.blank()); } else this.r++; }

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
        else if (fin === "J") { if (n === 2) { this.grid = Array.from({ length: this.rows }, () => this.blank()); } else { for (let x = this.c; x < this.cols; x++) this.grid[this.r][x] = " "; for (let y = this.r + 1; y < this.rows; y++) this.grid[y] = this.blank(); } }
        else if (fin === "K") for (let x = n === 2 ? 0 : this.c; x < this.cols; x++) this.grid[this.r][x] = " ";
        else if (fin === "H") { this.r = Math.max(0, (n || 1) - 1); this.c = 0; }
        continue;
      }
      i++;
      if (ch === "\r") { this.c = 0; this.pending = false; }
      else if (ch === "\n") { this.lf(); this.pending = false; }
      else if (ch < " ") continue;
      else {
        const cp = ch.codePointAt(0)!, w = cpWidth(cp);
        let g = ch; if (cp > 0xffff) { g = s.slice(i - 1, i + 1); i++; }
        if (this.pending || this.c + w > this.cols) { this.c = 0; this.lf(); this.pending = false; }   // deferred autowrap, like a real terminal
        this.grid[this.r][this.c] = g; if (w === 2 && this.c + 1 < this.cols) this.grid[this.r][this.c + 1] = "";
        this.c += w; if (this.c >= this.cols) { this.c = this.cols - 1; this.pending = true; }
      }
    }
  }
  /** Visible rows (trailing blanks trimmed). */
  screen(): string[] { const rows = this.grid.map((r) => r.join("").replace(/\s+$/, "")); while (rows.length && !rows.at(-1)) rows.pop(); return rows; }
  /** Everything the user could scroll through: scrollback followed by the visible screen. */
  all(): string[] { return [...this.scrollback, ...this.screen()]; }
}

// Multi-line input editor as a pure state machine (no terminal I/O), so every behaviour is unit-testable.
import { cellWidth, cpWidth } from "./text.ts";

export type Layout = { rows: { line: number; start: number; end: number }[]; cursorRow: number; cursorCol: number };
const PH = /\[Pasted text #(\d+) \+\d+ lines?\]/g;
const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

export class Editor {
  lines: string[] = [""];
  row = 0;
  col = 0;                       // UTF-16 index into lines[row]
  width = 80;                    // content width used for visual-line movement (set by render)
  history: string[] = [];
  private hIdx = -1;
  private draft = "";
  private goal: number | null = null;   // desired display column for vertical moves
  private pastes = new Map<number, string>();
  private pasteN = 0;

  get text() { return this.lines.join("\n"); }
  get empty() { return this.text.length === 0; }
  get cursorIndex() { return this.lines.slice(0, this.row).reduce((n, l) => n + l.length + 1, 0) + this.col; }

  setText(t: string, cursor: "end" | number = "end") {
    this.lines = t.split("\n"); this.goal = null;
    if (cursor === "end") { this.row = this.lines.length - 1; this.col = this.lines[this.row].length; }
    else { let i = cursor; this.row = 0; while (this.row < this.lines.length - 1 && i > this.lines[this.row].length) { i -= this.lines[this.row].length + 1; this.row++; } this.col = i; }
  }
  clear() { this.setText(""); this.pastes.clear(); this.hIdx = -1; }

  insert(s: string) {
    s = s.replace(/\r\n?/g, "\n"); this.goal = null;
    const parts = s.split("\n"), cur = this.lines[this.row], tail = cur.slice(this.col);
    this.lines[this.row] = cur.slice(0, this.col) + parts[0];
    if (parts.length === 1) { this.lines[this.row] += tail; this.col += parts[0].length; return; }
    const mid = parts.slice(1, -1), last = parts.at(-1)!;
    this.lines.splice(this.row + 1, 0, ...mid, last + tail);
    this.row += parts.length - 1; this.col = last.length;
  }

  /** Large pastes become a short placeholder (like Claude Code); `submit()` expands it back. */
  paste(s: string) {
    s = s.replace(/\r\n?/g, "\n");
    const n = s.split("\n").length;
    if (s.length > 600 || n > 8) { const id = ++this.pasteN; this.pastes.set(id, s); this.insert(`[Pasted text #${id} +${n} line${n > 1 ? "s" : ""}]`); }
    else this.insert(s);
  }
  newline() { this.insert("\n"); }

  private prevIdx(s: string, i: number) { if (i <= 0) return 0; i--; if (i > 0 && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff) i--; return i; }
  private nextIdx(s: string, i: number) { if (i >= s.length) return s.length; const c = s.charCodeAt(i); return i + (c >= 0xd800 && c <= 0xdbff ? 2 : 1); }

  backspace() {
    this.goal = null;
    if (this.col > 0) {
      const before = this.lines[this.row].slice(0, this.col), m = before.match(/\[Pasted text #\d+ \+\d+ lines?\]$/);   // delete a placeholder as one unit
      const from = m ? this.col - m[0].length : this.prevIdx(before, this.col);
      this.lines[this.row] = this.lines[this.row].slice(0, from) + this.lines[this.row].slice(this.col); this.col = from;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1]; this.lines[this.row - 1] = prev + this.lines[this.row];
      this.lines.splice(this.row, 1); this.row--; this.col = prev.length;
    }
  }
  del() {
    this.goal = null; const l = this.lines[this.row];
    if (this.col < l.length) this.lines[this.row] = l.slice(0, this.col) + l.slice(this.nextIdx(l, this.col));
    else if (this.row < this.lines.length - 1) { this.lines[this.row] = l + this.lines[this.row + 1]; this.lines.splice(this.row + 1, 1); }
  }
  left() { this.goal = null; if (this.col > 0) this.col = this.prevIdx(this.lines[this.row], this.col); else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; } }
  right() { this.goal = null; const l = this.lines[this.row]; if (this.col < l.length) this.col = this.nextIdx(l, this.col); else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; } }
  home() { this.goal = null; this.col = 0; }
  end() { this.goal = null; this.col = this.lines[this.row].length; }
  wordLeft() {
    this.goal = null;
    if (this.col === 0) return this.left();
    const l = this.lines[this.row]; let i = this.col;
    while (i > 0 && !isWord(l[i - 1])) i--;
    while (i > 0 && isWord(l[i - 1])) i--;
    this.col = i;
  }
  wordRight() {
    this.goal = null;
    const l = this.lines[this.row];
    if (this.col >= l.length) return this.right();
    let i = this.col;
    while (i < l.length && !isWord(l[i])) i++;
    while (i < l.length && isWord(l[i])) i++;
    this.col = i;
  }
  deleteWordBack() { const to = this.col; this.wordLeft(); this.lines[this.row] = this.lines[this.row].slice(0, this.col) + this.lines[this.row].slice(to); }
  killToEnd() { this.goal = null; const l = this.lines[this.row]; if (this.col < l.length) this.lines[this.row] = l.slice(0, this.col); else this.del(); }
  killToStart() { this.goal = null; this.lines[this.row] = this.lines[this.row].slice(this.col); this.col = 0; }

  /** Soft-wrapped visual rows for a given content width, plus where the cursor lands. */
  layout(width: number): Layout {
    const w = Math.max(4, width), rows: Layout["rows"] = [];
    let cursorRow = 0, cursorCol = 0;
    this.lines.forEach((line, li) => {
      let start = 0, i = 0, vis = 0, lastSpace = -1;
      const push = (end: number) => { rows.push({ line: li, start, end }); };
      while (i < line.length) {
        const cp = line.codePointAt(i)!, ch = String.fromCodePoint(cp), cw = cpWidth(cp);
        if (vis + cw > w) {
          const brk = lastSpace > start ? lastSpace + 1 : i;
          push(brk); start = brk; i = brk; vis = cellWidth(line.slice(start, i)); lastSpace = -1; continue;
        }
        if (ch === " ") lastSpace = i;
        vis += cw; i += ch.length;
      }
      push(line.length);
    });
    rows.forEach((r, idx) => {
      if (r.line !== this.row) return;
      const last = idx === rows.length - 1 || rows[idx + 1].line !== r.line;
      if (this.col >= r.start && (this.col < r.end || (last && this.col <= r.end))) { cursorRow = idx; cursorCol = cellWidth(this.lines[r.line].slice(r.start, this.col)); }
    });
    return { rows, cursorRow, cursorCol };
  }

  /** Move the cursor one visual row up/down. Returns false at the top/bottom edge (caller can then browse history). */
  vertical(dir: -1 | 1): boolean {
    const lay = this.layout(this.width), target = lay.cursorRow + dir;
    if (target < 0 || target >= lay.rows.length) return false;
    this.goal ??= lay.cursorCol;
    const r = lay.rows[target], text = this.lines[r.line];
    let col = r.start, w = 0;
    while (col < r.end) { const cw = cpWidth(text.codePointAt(col)!); if (w + cw > this.goal) break; w += cw; col += text.codePointAt(col)! > 0xffff ? 2 : 1; }
    const lastRowOfLine = target === lay.rows.length - 1 || lay.rows[target + 1].line !== r.line;   // the cursor may sit after the final character only
    this.row = r.line; this.col = Math.min(col, lastRowOfLine ? r.end : Math.max(r.start, r.end - 1));
    return true;
  }

  /** ↑ at the top row recalls older input, ↓ at the bottom row newer input. Returns whether anything changed. */
  historyPrev(): boolean {
    if (!this.history.length || this.hIdx + 1 >= this.history.length) return false;
    if (this.hIdx === -1) this.draft = this.text;
    this.hIdx++; this.setText(this.history[this.hIdx]); return true;
  }
  historyNext(): boolean {
    if (this.hIdx < 0) return false;
    this.hIdx--; this.setText(this.hIdx < 0 ? this.draft : this.history[this.hIdx]); return true;
  }

  /** Final text with paste placeholders expanded. Records history and clears the buffer. */
  submit(): string {
    const out = this.text.replace(PH, (m, id) => this.pastes.get(Number(id)) ?? m).trim();
    if (out && this.history[0] !== out) this.history.unshift(out);
    this.history = this.history.slice(0, 200);
    this.clear();
    return out;
  }

  /** Lines to draw (prompt gutter included) and the cursor position inside them. */
  render(width: number, prompt = "❯ ", cont = "  "): { lines: string[]; cursor: { row: number; col: number } } {
    const gw = cellWidth(prompt), cw = Math.max(8, width - gw);
    this.width = cw;
    const lay = this.layout(cw);
    const lines = lay.rows.map((r, i) => (i === 0 ? prompt : cont) + this.lines[r.line].slice(r.start, r.end).replace(/ $/, (m) => (r.end === this.lines[r.line].length ? m : m)));
    return { lines, cursor: { row: lay.cursorRow, col: gw + lay.cursorCol } };
  }
}

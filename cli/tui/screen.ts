// Inline terminal renderer: finished output goes into normal scrollback; a small "live region" (status, input box, overlays)
// is redrawn in place at the bottom. Same model as Claude Code / Copilot CLI: no alternate screen, so native scrollback and copy/paste still work.
import { cellWidth, clipAnsi } from "./text.ts";

export type Out = { write(s: string): unknown; columns?: number; rows?: number; isTTY?: boolean };

export class Screen {
  out: Out;
  private cursorRow = 0;          // where the cursor sits inside the live region (0 = its first line)
  private cursorCol = 0;
  private lastCols = 0;
  private lastWidths: number[] = [];
  height = 0;                     // lines currently occupied by the live region
  alt = false;
  constructor(out: Out) { this.out = out; }

  get cols() { return Math.max(20, this.out.columns || 80); }
  get rows() { return Math.max(6, this.out.rows || 24); }

  /**
   * One atomic frame: erase the old live region, print `committed` lines into scrollback, draw the new live region and park the cursor at `cursor`.
   * Wrapped in synchronized-output markers so supporting terminals never show a half-drawn frame.
   */
  frame(committed: string[], live: string[], cursor?: { row: number; col: number }) {
    if (this.alt) return;
    const cols = this.cols, maxLive = this.rows - 1;
    const lines = (live.length > maxLive ? live.slice(live.length - maxLive) : live).map((l) => clipAnsi(l, cols));
    const shifted = live.length - lines.length;                                   // rows dropped from the top when the region is taller than the terminal
    let s = "\x1b[?2026h\x1b[?25l";
    if (this.height > 0) {
      let up = this.cursorRow;
      if (this.lastCols && this.lastCols !== cols) {                                  // the window was resized: terminals re-wrap old rows, so count how many rows the region really spans now
        const rows = (w: number) => Math.max(1, Math.ceil(w / cols));
        up = this.lastWidths.slice(0, this.cursorRow).reduce((n, w) => n + rows(w), 0) + Math.floor(this.cursorCol / cols);
      }
      s += (up > 0 ? `\x1b[${up}A` : "") + "\r\x1b[J";
    }
    for (const l of committed) s += l + "\x1b[0m\r\n";
    s += lines.join("\r\n");
    let row = Math.max(0, lines.length - 1);
    if (lines.length && cursor) {
      const target = Math.max(0, Math.min(lines.length - 1, cursor.row - shifted));
      if (row > target) s += `\x1b[${row - target}A`;
      s += "\r" + (cursor.col > 0 ? `\x1b[${Math.min(cursor.col, cols - 1)}C` : "");
      row = target;
    }
    s += "\x1b[?25h\x1b[?2026l";
    this.out.write(s);
    this.cursorRow = row; this.height = lines.length;
    this.cursorCol = cursor ? Math.min(cursor.col, cols - 1) : cellWidth(lines.at(-1) ?? "");
    this.lastCols = cols; this.lastWidths = lines.map((l) => cellWidth(l));
  }

  /** Remove the live region entirely (before exiting, or before handing the terminal to something else). */
  clear() {
    if (this.height > 0) this.out.write((this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : "") + "\r\x1b[J");
    this.height = 0; this.cursorRow = 0;
  }

  enterAlt() { this.alt = true; this.out.write("\x1b[?1049h\x1b[?25l"); }
  leaveAlt() { this.alt = false; this.out.write("\x1b[?1049l\x1b[?25h"); }
}

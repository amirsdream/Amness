// Vim-style editing for the input box (/vim). Insert mode is the normal editor; Esc switches to normal mode, where keys move and edit instead of typing.
// Works on the Editor's public state, so undo/redo, history and paste placeholders behave the same in both modes.
import type { Editor } from "./editor.ts";
import type { Key } from "./keys.ts";

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

export class Vim {
  mode: "insert" | "normal" = "insert";
  /** an operator or prefix waiting for its second key: d, c, y, g */
  private op = "";
  /** a count typed before a command (3w, 2dd) */
  private count = "";
  /** what dd / dw / yy / x put away, for p and P */
  register = "";

  /** Esc in insert mode: go to normal mode, cursor one to the left (as in vim). */
  toNormal(ed: Editor) { this.mode = "normal"; this.op = this.count = ""; if (ed.col > 0) ed.left(); }

  /**
   * A key in normal mode. Returns "submit" for Enter, true when the key was used, false when the app should handle it (Esc, ctrl keys other than redo).
   * Unknown printable keys are swallowed, so a stray letter never ends up in the message.
   */
  key(ed: Editor, k: Key): boolean | "submit" {
    if (k.name === "enter") { this.op = this.count = ""; this.mode = "insert"; return "submit"; }   // the next message starts in insert mode
    if (k.ctrl && k.name === "r") { ed.redo(); return true; }
    if (k.name === "escape") { if (this.op || this.count) { this.op = this.count = ""; return true; } return false; }
    if (k.ctrl || k.name === "paste") return false;
    if (["left", "right", "up", "down", "home", "end", "backspace", "delete"].includes(k.name)) {
      const map: Record<string, string> = { left: "h", right: "l", up: "k", down: "j", home: "0", end: "$", backspace: "h", delete: "x" };
      return this.key(ed, { name: "char", text: map[k.name] });
    }
    if (k.name !== "char") return false;                                                  // tab, shift+tab, mouse and the like keep their usual meaning
    if (!k.text || k.alt) return true;
    if ([...k.text].length > 1) {                                                         // keys typed fast arrive as one burst
      const chars = [...k.text];
      for (let i = 0; i < chars.length; i++) { this.key(ed, { name: "char", text: chars[i] }); if (this.mode === "insert") { const rest = chars.slice(i + 1).join(""); if (rest) ed.insert(rest); break; } }   // after i/a/o the rest is typed text
      return true;
    }
    const c = k.text;
    if (/^[1-9]$/.test(c) || (c === "0" && this.count)) { this.count += c; return true; }
    const n = Math.max(1, Number(this.count || "1")); this.count = "";
    const op = this.op; this.op = "";
    if (op === "g") { if (c === "g") { ed.row = 0; ed.col = 0; } return true; }
    if (op === "d" || op === "c" || op === "y") return this.operator(ed, op, c, n);
    switch (c) {
      case "i": this.mode = "insert"; return true;
      case "a": if (ed.col < ed.lines[ed.row].length) ed.right(); this.mode = "insert"; return true;
      case "I": this.firstNonBlank(ed); this.mode = "insert"; return true;
      case "A": ed.end(); this.mode = "insert"; return true;
      case "o": ed.end(); ed.newline(); this.mode = "insert"; return true;
      case "O": ed.home(); ed.newline(); ed.row--; ed.col = 0; this.mode = "insert"; return true;
      case "h": for (let i = 0; i < n && ed.col > 0; i++) ed.left(); return true;
      case "l": for (let i = 0; i < n && ed.col < ed.lines[ed.row].length - 1; i++) ed.right(); return true;
      case "j": for (let i = 0; i < n; i++) if (!ed.vertical(1)) { ed.historyNext(); break; } return true;
      case "k": for (let i = 0; i < n; i++) if (!ed.vertical(-1)) { ed.historyPrev(); break; } return true;
      case "w": for (let i = 0; i < n; i++) this.wordStart(ed); return true;
      case "b": for (let i = 0; i < n; i++) ed.wordLeft(); return true;
      case "e": for (let i = 0; i < n; i++) this.wordEnd(ed); return true;
      case "0": ed.home(); return true;
      case "^": this.firstNonBlank(ed); return true;
      case "$": ed.end(); if (ed.col > 0) ed.col--; return true;
      case "G": ed.row = ed.lines.length - 1; ed.col = 0; return true;
      case "x": this.cut(ed, ed.cursorIndex, Math.min(ed.cursorIndex + n, this.lineEnd(ed))); return true;
      case "X": { const a = Math.max(this.lineStart(ed), ed.cursorIndex - n); this.cut(ed, a, ed.cursorIndex); return true; }
      case "D": this.cut(ed, ed.cursorIndex, this.lineEnd(ed)); return true;
      case "C": this.cut(ed, ed.cursorIndex, this.lineEnd(ed)); this.mode = "insert"; return true;
      case "S": this.cut(ed, this.lineStart(ed), this.lineEnd(ed)); this.mode = "insert"; return true;
      case "p": case "P": if (this.register) { if (c === "p" && ed.col < ed.lines[ed.row].length) ed.right(); ed.insert(this.register); } return true;
      case "u": for (let i = 0; i < n; i++) ed.undo(); return true;
      case "d": case "c": case "y": case "g": this.op = c; if (n > 1) this.count = String(n); return true;
    }
    return true;
  }

  private operator(ed: Editor, op: string, c: string, n: number): boolean {
    let a = ed.cursorIndex, b = a;
    if (c === op) {                                                                       // dd, cc, yy: whole lines
      const first = ed.row, last = Math.min(ed.lines.length - 1, ed.row + n - 1);
      a = ed.lines.slice(0, first).reduce((s, l) => s + l.length + 1, 0); b = a + ed.lines.slice(first, last + 1).join("\n").length;
      const text = ed.text, whole = text.slice(a, b) + "\n";
      if (op === "y") { this.register = whole; return true; }
      this.register = whole;
      if (op === "c") { ed.setText(text.slice(0, a) + text.slice(b), a); this.mode = "insert"; return true; }
      const lo = a > 0 && b >= text.length ? a - 1 : a, hi = b < text.length ? b + 1 : b;    // take one of the newlines with the lines
      ed.setText(text.slice(0, lo) + text.slice(hi), Math.min(lo, Math.max(0, text.length - (hi - lo)))); return true;
    }
    const save = { row: ed.row, col: ed.col };
    for (let i = 0; i < n; i++) { if (c === "w") (op === "c" ? this.wordEnd(ed, true) : this.wordStart(ed)); else if (c === "e") this.wordEnd(ed, true); else if (c === "b") ed.wordLeft(); else if (c === "$") ed.end(); else if (c === "0") ed.home(); else break; }
    b = ed.cursorIndex; ed.row = save.row; ed.col = save.col;
    if (b === a) return true;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (op === "y") { this.register = ed.text.slice(lo, hi); return true; }
    this.cut(ed, lo, hi); if (op === "c") this.mode = "insert";
    return true;
  }
  /** Remove text[a, b) into the register as one undo step. */
  private cut(ed: Editor, a: number, b: number) { if (b <= a) return; const t = ed.text; this.register = t.slice(a, b); ed.setText(t.slice(0, a) + t.slice(b), a); }
  private lineStart(ed: Editor) { return ed.cursorIndex - ed.col; }
  private lineEnd(ed: Editor) { return this.lineStart(ed) + ed.lines[ed.row].length; }
  private firstNonBlank(ed: Editor) { ed.col = ed.lines[ed.row].length - ed.lines[ed.row].trimStart().length; }
  /** w: to the start of the next word (on the same line, else the next line). */
  private wordStart(ed: Editor) {
    const l = ed.lines[ed.row]; let i = ed.col;
    if (i >= l.length) { if (ed.row < ed.lines.length - 1) { ed.row++; ed.col = 0; this.firstNonBlank(ed); } return; }
    const w = isWord(l[i]); while (i < l.length && l[i] !== " " && isWord(l[i]) === w) i++;
    while (i < l.length && l[i] === " ") i++;
    ed.col = i;
  }
  /** e: to the last character of this or the next word. With `past`, one beyond it (the end of a range for ce/de). */
  private wordEnd(ed: Editor, past = false) {
    const l = ed.lines[ed.row]; let i = ed.col + (past ? 0 : 1);
    while (i < l.length && l[i] === " ") i++;
    const w = isWord(l[i]); while (i + 1 < l.length && l[i + 1] !== " " && isWord(l[i + 1]) === w) i++;
    ed.col = Math.min(l.length, past ? i + 1 : i);
  }
}

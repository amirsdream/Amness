// Raw terminal input -> key events. Handles CSI/SS3 sequences, modifiers, alt-combos, kitty "CSI u", and bracketed paste.
export type Key = { name: string; text?: string; ctrl?: boolean; alt?: boolean; shift?: boolean };

export const PASTE_ON = "\x1b[?2004h", PASTE_OFF = "\x1b[?2004l";
const mods = (m: number): Pick<Key, "ctrl" | "alt" | "shift"> => ({ shift: !!((m - 1) & 1) || undefined, alt: !!((m - 1) & 2) || undefined, ctrl: !!((m - 1) & 4) || undefined });
const clean = (k: Key): Key => Object.fromEntries(Object.entries(k).filter(([, v]) => v !== undefined)) as Key;
const FINAL: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab", P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE: Record<string, string> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };

export class KeyParser {
  private buf = "";
  private pasting: string | null = null;

  /** Feed raw input; returns the keys that are complete. A trailing lone ESC (or partial sequence) is held until `flush()`. */
  feed(chunk: string): Key[] {
    this.buf += chunk;
    const out: Key[] = [];
    for (;;) {
      if (this.pasting !== null) {
        const end = this.buf.indexOf("\x1b[201~");
        if (end < 0) { this.pasting += this.buf; this.buf = ""; return out; }
        out.push({ name: "paste", text: (this.pasting + this.buf.slice(0, end)).replace(/\r\n?/g, "\n") });
        this.buf = this.buf.slice(end + 6); this.pasting = null;
        continue;
      }
      if (!this.buf) return out;
      const r = this.one();
      if (!r) return out;                                    // incomplete: wait for more bytes
      this.buf = this.buf.slice(r.len);
      if (r.key) out.push(r.key);
    }
  }

  /** Called after a short idle: whatever is pending (a lone ESC) is a real key press. */
  flush(): Key[] {
    if (this.buf === "\x1b") { this.buf = ""; return [{ name: "escape" }]; }
    if (this.pasting === null && this.buf) { const b = this.buf; this.buf = ""; return [{ name: "char", text: b }]; }
    return [];
  }
  get pending() { return this.buf.length > 0; }

  private one(): { key?: Key; len: number } | null {
    const b = this.buf, c = b[0];
    if (c === "\x1b") {
      if (b.length === 1) return null;
      if (b[1] === "[") {
        const m = b.slice(2).match(/^([0-9;:?<=>]*)([A-Za-z~])/);
        if (!m) return b.length < 24 ? null : { len: 1, key: { name: "escape" } };
        const len = 2 + m[0].length, [p0 = "", p1 = ""] = m[1].split(";"), fin = m[2];
        if (m[1] === "200" && fin === "~") { this.pasting = ""; return { len }; }
        const mod = p1 ? Number(p1.split(":")[0]) : 1;
        if (fin === "u") {                                   // kitty keyboard protocol
          const code = Number(p0), name = code === 13 ? "enter" : code === 9 ? "tab" : code === 27 ? "escape" : code === 127 ? "backspace" : "char";
          return { len, key: clean(name === "char" ? { name, text: String.fromCodePoint(code), ...mods(mod) } : { name, ...mods(mod) }) };
        }
        const name = fin === "~" ? TILDE[p0] : FINAL[fin];
        return { len, key: name ? clean({ name, ...mods(mod) }) : undefined };
      }
      if (b[1] === "O") { if (b.length < 3) return null; const name = FINAL[b[2]]; return { len: 3, key: name ? { name } : undefined }; }
      if (b[1] === "\x1b") return { len: 1, key: { name: "escape" } };
      const inner = this.ctrlOrChar(b[1]);                   // ESC + key = alt+key
      return { len: 2, key: inner ? clean({ ...inner, alt: true }) : undefined };
    }
    // a run of printable text becomes one key (typed chars arrive one by one; a burst is a paste without bracketed-paste support)
    const run = b.match(/^[^\x00-\x1f\x7f]+/u);
    if (run) {
      const rest = b.slice(run[0].length);
      if (rest && /^[\r\n]/.test(rest) && run[0].length > 1 && !this.buf.slice(run[0].length).startsWith("\x1b")) {
        const nl = rest.match(/^[^\x1b]*/)![0];             // text + newlines in one chunk without markers: treat as a paste
        if (/[^\r\n]/.test(nl) || nl.length > 1) return { len: run[0].length + nl.length, key: { name: "paste", text: (run[0] + nl).replace(/\r\n?/g, "\n").replace(/\n$/, "") } };
      }
      return { len: run[0].length, key: { name: "char", text: run[0] } };
    }
    return { len: 1, key: this.ctrlOrChar(c) };
  }

  private ctrlOrChar(c: string): Key | undefined {
    switch (c) {
      case "\r": return { name: "enter" };
      case "\n": return { name: "j", ctrl: true };
      case "\t": return { name: "tab" };
      case "\x7f": return { name: "backspace" };
      case "\x08": return { name: "backspace", ctrl: true };
      case "\x1b": return { name: "escape" };
      case "\x00": return { name: "space", ctrl: true };
    }
    const code = c.codePointAt(0)!;
    if (code >= 1 && code <= 26) return { name: String.fromCharCode(96 + code), ctrl: true };
    return code >= 32 ? { name: "char", text: c } : undefined;
  }
}

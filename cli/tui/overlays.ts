// Modal pieces drawn in the live region in place of the input box: choices, pickers, text input, help.
import { bold, cyan, dim, gray } from "../ui.ts";
import { Editor } from "./editor.ts";
import type { Key } from "./keys.ts";
import { cellWidth, clipWidth, strip } from "./text.ts";
import { framed, helpLines, optionList, type Option } from "./view.ts";

export type Drawn = { lines: string[]; cursor?: { row: number; col: number } };
export interface Overlay { render(width: number): Drawn; key(k: Key): void; }

/** What a permission prompt is about, in a form the full-screen UI can draw properly (the inline UI uses `body`). */
export type ChoiceDetail =
  | { kind: "diff"; path: string; diff: string }
  | { kind: "command"; cmd: string; danger?: string }
  | { kind: "plan"; md: string }
  | { kind: "text"; text: string };

/** Standard text-editing keys, shared by the main input and text overlays. Returns true if the key was consumed. */
export function editKey(ed: Editor, k: Key): boolean {
  if (k.name === "paste") { ed.paste(k.text ?? ""); return true; }
  if (k.name === "char") {
    if (k.alt && k.text === "b") ed.wordLeft(); else if (k.alt && k.text === "f") ed.wordRight(); else if (k.alt && k.text === "d") { ed.wordRight(); ed.deleteWordBack(); }
    else if (!k.alt && !k.ctrl) ed.insert(k.text ?? ""); else return false;
    return true;
  }
  if (k.ctrl && !k.alt) {
    switch (k.name) {
      case "a": ed.home(); return true; case "e": ed.end(); return true; case "b": ed.left(); return true; case "f": ed.right(); return true;
      case "k": ed.killToEnd(); return true; case "u": ed.killToStart(); return true; case "w": ed.deleteWordBack(); return true; case "h": ed.backspace(); return true;
      case "j": ed.newline(); return true; case "d": if (!ed.empty) { ed.del(); return true; } return false;
      case "left": ed.wordLeft(); return true; case "right": ed.wordRight(); return true;
    }
  }
  switch (k.name) {
    case "left": k.alt || k.ctrl ? ed.wordLeft() : ed.left(); return true;
    case "right": k.alt || k.ctrl ? ed.wordRight() : ed.right(); return true;
    case "home": ed.home(); return true; case "end": ed.end(); return true;
    case "backspace": k.alt ? ed.deleteWordBack() : ed.backspace(); return true;
    case "delete": ed.del(); return true;
    case "enter": if (k.alt || k.shift) { ed.newline(); return true; } return false;
  }
  return false;
}

/** Numbered choices inside a titled box (permission prompts). Resolves with the chosen index, or undefined on Esc. */
export class ChoiceOverlay implements Overlay {
  sel = 0;
  title: string; body: string[]; question: string; options: Option[]; done: (i: number | undefined) => void; detail?: ChoiceDetail;
  constructor(title: string, body: string[], question: string, options: Option[], done: (i: number | undefined) => void, paint?: (s: string) => string, detail?: ChoiceDetail) {
    this.title = title; this.body = body; this.question = question; this.options = options; this.done = done; this.paint = paint; this.detail = detail;
  }
  paint?: (s: string) => string;
  render(width: number): Drawn {
    return { lines: [...framed(this.title, this.body, Math.min(width, 100), this.paint), " " + bold(this.question), ...optionList(this.options, this.sel).map((l) => " " + l), dim("  ↑/↓ choose · enter confirm · esc cancel")] };
  }
  key(k: Key) {
    if (k.name === "up" || (k.name === "char" && k.text === "k")) this.sel = (this.sel + this.options.length - 1) % this.options.length;
    else if (k.name === "down" || k.name === "tab" || (k.name === "char" && k.text === "j")) this.sel = (this.sel + 1) % this.options.length;
    else if (k.name === "char" && /^[1-9]$/.test(k.text ?? "") && Number(k.text) <= this.options.length) this.done(Number(k.text) - 1);
    else if (k.name === "enter") this.done(this.sel);
    else if (k.name === "escape" || (k.ctrl && k.name === "c")) this.done(undefined);
  }
}

export type PickItem<T> = { label: string; value: T; hint?: string };
/** Filterable list. Type to filter, ↑/↓ to move, enter to pick, esc to cancel. */
export class PickerOverlay<T> implements Overlay {
  sel = 0; filter = "";
  title: string; items: PickItem<T>[]; done: (v: T | undefined) => void; max: number;
  constructor(title: string, items: PickItem<T>[], done: (v: T | undefined) => void, initial = 0, max = 10) { this.title = title; this.items = items; this.done = done; this.sel = initial; this.max = max; }
  visible() { const f = this.filter.toLowerCase(); return f ? this.items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(f)) : this.items; }
  /** Called whenever the highlighted item changes (live theme preview). */
  onMove?: (v: T | undefined) => void;
  /** Choose the i-th visible item (mouse click). */
  pick(i: number) { const it = this.visible()[i]; if (it) this.done(it.value); }
  private moved() { this.onMove?.(this.visible()[this.sel]?.value); }
  render(width: number): Drawn {
    const list = this.visible(); this.sel = Math.max(0, Math.min(this.sel, list.length - 1));
    const top = Math.max(0, Math.min(this.sel - Math.floor(this.max / 2), list.length - this.max)), slice = list.slice(top, top + this.max);
    const lw = Math.min(40, Math.max(0, ...slice.map((i) => cellWidth(i.label))));
    const rows = slice.map((it, k) => {
      const on = top + k === this.sel, label = clipWidth(it.label, lw) + " ".repeat(Math.max(0, lw - cellWidth(it.label)));
      const line = (on ? cyan("❯ ") + bold(cyan(label)) : "  " + label) + (it.hint ? "  " + (on ? gray(it.hint) : dim(it.hint)) : "");
      return cellWidth(strip(line)) > width - 1 ? line.slice(0, width + 10) : line;
    });
    const head = bold(this.title) + (this.filter ? "  " + cyan("/") + this.filter : dim(this.items.length > this.max ? "  (type to filter)" : ""));
    return { lines: [head, ...(top > 0 ? [dim(`  ↑ ${top} more`)] : []), ...rows, ...(top + this.max < list.length ? [dim(`  ↓ ${list.length - top - this.max} more`)] : []), ...(list.length ? [] : [dim("  no matches")]), dim("  ↑/↓ move · enter select · esc cancel")] };
  }
  key(k: Key) {
    const list = this.visible();
    if (k.name === "up") { this.sel = (this.sel + list.length - 1) % Math.max(1, list.length); this.moved(); }
    else if (k.name === "down") { this.sel = (this.sel + 1) % Math.max(1, list.length); this.moved(); }
    else if (k.name === "enter") { if (list.length) this.done(list[this.sel].value); }
    else if (k.name === "escape" || (k.ctrl && k.name === "c")) this.done(undefined);
    else if (k.name === "backspace") { this.filter = this.filter.slice(0, -1); this.sel = 0; }
    else if (k.name === "char" && !k.alt && !k.ctrl) { this.filter += k.text; this.sel = 0; }
  }
}

/** One-shot text prompt ("what should it do instead?", API key). Esc cancels. */
export class InputOverlay implements Overlay {
  ed = new Editor();
  prompt: string; secret: boolean; done: (v: string | undefined) => void; hint: string;
  constructor(prompt: string, done: (v: string | undefined) => void, o: { secret?: boolean; initial?: string; hint?: string } = {}) {
    this.prompt = prompt; this.done = done; this.secret = !!o.secret; this.hint = o.hint ?? "enter to confirm · esc to cancel";
    if (o.initial) this.ed.insert(o.initial);
  }
  render(width: number): Drawn {
    if (this.secret) { const n = this.ed.text.length; return { lines: [" " + bold(this.prompt), "❯ " + "•".repeat(n), dim("  " + this.hint)], cursor: { row: 1, col: 2 + n } }; }
    const r = this.ed.render(width - 1);
    return { lines: [" " + bold(this.prompt), ...r.lines, dim("  " + this.hint)], cursor: { row: 1 + r.cursor.row, col: r.cursor.col } };
  }
  key(k: Key) {
    if (k.name === "escape" || (k.ctrl && k.name === "c")) return this.done(undefined);
    if (k.name === "enter" && !k.alt && !k.shift) return this.done(this.ed.text.trim());
    if (k.name === "paste" && this.secret) return void this.ed.insert((k.text ?? "").replace(/\s+/g, ""));
    editKey(this.ed, k);
  }
}

/** Static text (help) closed by any key. */
export class TextOverlay implements Overlay {
  lines: string[]; done: () => void; scroll = 0;
  constructor(lines: string[], done: () => void) { this.lines = lines; this.done = done; }
  render(): Drawn { return { lines: [...this.lines, dim("  press any key to close")] }; }
  key(k?: Key) {
    const step = k?.name === "up" ? -1 : k?.name === "down" ? 1 : k?.name === "pageup" ? -10 : k?.name === "pagedown" ? 10 : k?.name === "home" ? -1e6 : k?.name === "end" ? 1e6 : 0;
    if (step) this.scroll = Math.max(0, this.scroll + step); else this.done();         // arrows scroll long text; anything else closes it
  }
}

export const helpOverlay = (cmds: { name: string; help: string }[], done: () => void, width: number) => new TextOverlay(helpLines(cmds, width), done);

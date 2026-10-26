// Full-transcript viewer (Ctrl+O): alternate screen, scrollable, with tool output shown in full.
import type { Message } from "../../src/index.ts";
import { bold, cyan, dim, gray, green, red } from "../ui.ts";
import type { Key } from "./keys.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Out } from "./screen.ts";
import { clipAnsi, wrapAnsi } from "./text.ts";
import { argSummary, isFailure, toolLabel } from "./view.ts";

export function transcriptLines(messages: Message[], width: number): string[] {
  const out: string[] = [], names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") { out.push("", ...wrapAnsi(m.content ?? "", width - 2).map((l, i) => (i ? "  " : bold(cyan("❯ "))) + bold(l))); continue; }
    if (m.role === "assistant") {
      if (m.content?.trim()) out.push("", ...renderMarkdown(m.content, width - 2).map((l, i) => (i ? "  " : bold("● ")) + l));
      for (const c of m.tool_calls ?? []) { names.set(c.id, c.function.name); out.push(`${bold(green("●"))} ${bold(toolLabel(c.function.name))}${dim("(")}${argSummary(c.function.name, c.function.arguments)}${dim(")")}`); }
      continue;
    }
    const body = (m.content ?? "").split("\n"), name = names.get(m.tool_call_id ?? "") ?? "";
    const paint = isFailure(m.content ?? "") ? red : gray;
    out.push(...body.slice(0, 400).flatMap((l) => wrapAnsi(paint(l), width - 5, 0)).map((l) => dim("  ⎿  ") + l));
    if (body.length > 400) out.push(dim(`  ⎿  … +${body.length - 400} more lines (${name})`));
  }
  return out;
}

export class Pager {
  top = 0;
  lines: string[]; out: Out; done: () => void; title: string;
  constructor(lines: string[], out: Out, done: () => void, title = "transcript", start: "top" | "bottom" = "bottom") { this.lines = lines; this.out = out; this.done = done; this.title = title; this.top = start === "top" ? 0 : Math.max(0, lines.length - this.page()); this.draw(); }
  private page() { return Math.max(3, (this.out.rows || 24) - 2); }
  draw() {
    const cols = this.out.columns || 80, page = this.page(), max = Math.max(0, this.lines.length - page);
    this.top = Math.max(0, Math.min(this.top, max));
    const pct = this.lines.length <= page ? 100 : Math.round((this.top / max) * 100);
    const body = this.lines.slice(this.top, this.top + page).map((l) => clipAnsi(l, cols));
    while (body.length < page) body.push("");
    this.out.write("\x1b[H\x1b[2J" + body.join("\r\n") + "\r\n" + dim(`  ${this.title} · ${pct}% · ↑/↓ j/k scroll · space/b page · g/G top/bottom · q/esc/ctrl+o close`));
  }
  key(k: Key) {
    const page = this.page();
    if (k.name === "escape" || (k.name === "char" && k.text === "q") || (k.ctrl && (k.name === "o" || k.name === "c"))) return this.done();
    if (k.name === "up" || (k.name === "char" && k.text === "k")) this.top--;
    else if (k.name === "down" || (k.name === "char" && k.text === "j") || k.name === "enter") this.top++;
    else if (k.name === "pagedown" || (k.name === "char" && k.text === " ")) this.top += page - 1;
    else if (k.name === "pageup" || (k.name === "char" && k.text === "b")) this.top -= page - 1;
    else if (k.name === "home" || (k.name === "char" && k.text === "g")) this.top = 0;
    else if (k.name === "end" || (k.name === "char" && k.text === "G")) this.top = this.lines.length;
    this.draw();
  }
}

// Tiny zero-dependency terminal UI: colors, boxes, arrow-key menus, prompts, spinner. Falls back to plain line input when piped.
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";

const color = (!!process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = sgr("1"), dim = sgr("2"), red = sgr("31"), green = sgr("32"), yellow = sgr("33"), blue = sgr("34"), magenta = sgr("35"), cyan = sgr("36"), gray = sgr("90");
export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
export const width = () => Math.min(process.stdout.columns || 80, 100);

/** Word-wrap one line (ANSI-aware) to `w` visible columns; continuation lines are indented 2 spaces. */
export function wrap(line: string, w: number): string[] {
  if (strip(line).length <= w) return [line];
  const reset = color ? "\x1b[0m" : "";
  const out: string[] = [];
  let cur = "", vis = 0, lastSpace = -1;
  for (const t of line.match(/\x1b\[[0-9;?]*[A-Za-z]|[^\x1b]/g) ?? []) {
    if (t[0] === "\x1b") { cur += t; continue; }
    if (vis >= w) {
      const cut = lastSpace > 0 ? lastSpace : cur.length;
      out.push(cur.slice(0, cut) + reset);
      cur = "  " + cur.slice(lastSpace > 0 ? cut + 1 : cut);
      vis = strip(cur).length; lastSpace = -1;
    }
    if (t === " ") lastSpace = cur.length;
    cur += t; vis++;
  }
  out.push(cur);
  return out;
}

export function box(input: string[], paint: (s: string) => string = cyan, title = ""): string {
  const w = Math.min(Math.max(...input.map((l) => strip(l).length), strip(title).length + 2), width() - 4);
  const lines = input.flatMap((l) => wrap(l, w));
  const top = title ? `╭─ ${title} ${"─".repeat(Math.max(0, w - strip(title).length - 1))}╮` : `╭${"─".repeat(w + 2)}╮`;
  return [paint(top), ...lines.map((l) => paint("│ ") + l + " ".repeat(Math.max(0, w - strip(l).length)) + paint(" │")), paint(`╰${"─".repeat(w + 2)}╯`)].join("\n");
}

// ---- line input shared by all prompts when stdin is not a TTY (piped / tests)
let lineIter: AsyncIterator<string> | undefined;
const nextLine = async () => ((lineIter ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]()), (await lineIter.next()).value as string | undefined);
const isTTY = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

/** Thrown when the user presses Esc inside a text prompt; screens let it bubble up to the menu. */
export class Cancel extends Error { constructor() { super("cancelled"); } }

export type Item<T> = { label: string; value: T; hint?: string };

/**
 * Arrow-key menu. ↑/↓ or j/k move, 1-9 jump, enter selects, esc goes back, "/" filters long lists, "?" toggles help.
 * Long lists scroll inside the terminal height. Returns undefined on back.
 */
export async function select<T>(title: string, items: Item<T>[], initial = 0): Promise<T | undefined> {
  if (!isTTY()) {
    console.log(`\n${bold(title)}`);
    items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}${it.hint ? "  " + dim(it.hint) : ""}`));
    const a = (await nextLine())?.trim();
    return a ? items[Number(a) - 1]?.value : undefined;
  }
  const out = process.stdout, inp = process.stdin;
  let cur = Math.min(initial, items.length - 1), top = 0, drawn = 0, filter = "", filtering = false, help = false;
  const vis = () => { const f = filter.toLowerCase(); return f ? items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(f)) : items; };
  const draw = () => {
    if (drawn) out.write(`\x1b[${drawn}A\x1b[J`);
    const list = vis(), room = Math.max(4, (out.rows || 24) - 7);
    cur = Math.max(0, Math.min(cur, list.length - 1));
    if (cur < top) top = cur; if (cur >= top + room) top = cur - room + 1;
    const slice = list.slice(top, top + room), labelW = Math.max(0, ...slice.map((i) => strip(i.label).length));
    const rows = [
      bold(title) + (filtering || filter ? "  " + cyan("/") + filter + (filtering ? cyan("▌") : "") : ""),
      ...(top > 0 ? [dim(`  ↑ ${top} more`)] : []),
      ...slice.map((it, k) => {
        const on = top + k === cur, pad = " ".repeat(labelW - strip(it.label).length);
        return (on ? cyan("❯ ") + bold(cyan(it.label)) : "  " + it.label) + pad + (it.hint ? "  " + (on ? gray(it.hint) : dim(it.hint)) : "");
      }),
      ...(top + room < list.length ? [dim(`  ↓ ${list.length - top - room} more`)] : []),
      ...(list.length ? [] : [dim("  no matches")]),
      dim(help ? "  ↑/↓ j/k move · 1-9 jump · enter select · esc back · / filter · ? hide help · ctrl-c quit"
        : filtering ? "  type to filter · enter select · esc clear filter" : "  ↑/↓ move · enter select · esc back" + (items.length > 6 ? " · / filter" : "") + " · ? help"),
    ];
    out.write(rows.map((r) => r.slice(0, Math.max(20, (out.columns || 80) + 20))).join("\n") + "\n"); drawn = rows.length;
  };
  emitKeypressEvents(inp); inp.setRawMode(true); inp.resume(); out.write("\x1b[?25l"); draw();
  return new Promise((resolve) => {
    const done = (v: T | undefined) => {
      inp.off("keypress", onKey); inp.setRawMode(false); inp.pause(); out.write("\x1b[?25h");
      out.write(`\x1b[${drawn}A\x1b[J${bold(title)} ${v === undefined ? dim("(back)") : cyan(items.find((i) => i.value === v)!.label)}\n`);
      resolve(v);
    };
    const onKey = (s: string | undefined, k: { name?: string; ctrl?: boolean }) => {
      const list = vis();
      if (k.ctrl && k.name === "c") { inp.setRawMode(false); out.write("\x1b[?25h\n"); process.exit(130); }
      if (filtering) {
        if (k.name === "return") return list.length ? done(list[cur].value) : draw();
        if (k.name === "escape") { filtering = false; filter = ""; cur = 0; }
        else if (k.name === "backspace") filter = filter.slice(0, -1);
        else if (k.name === "up") cur--; else if (k.name === "down") cur++;
        else if (s && s >= " " && !k.ctrl) { filter += s; cur = 0; }
        return draw();
      }
      if (k.name === "up" || s === "k") cur = (cur + list.length - 1) % list.length;
      else if (k.name === "down" || s === "j") cur = (cur + 1) % list.length;
      else if (k.name === "return") return done(list[cur]?.value);
      else if (k.name === "escape" || s === "q") { if (filter) { filter = ""; cur = 0; } else return done(undefined); }
      else if (s === "/" && items.length > 6) { filtering = true; filter = ""; }
      else if (s === "?") help = !help;
      else if (s && /^[1-9]$/.test(s) && list[Number(s) - 1]) return done(list[Number(s) - 1].value);
      draw();
    };
    inp.on("keypress", onKey);
  });
}

/**
 * Text prompt. Esc cancels (throws Cancel), up/down recall `history`, and pasted multi-line text arrives as ONE answer
 * instead of leaking into later prompts. With `multiline`, newlines in a paste are kept; otherwise they become spaces.
 */
export async function ask(prompt: string, def = "", o: { secret?: boolean; multiline?: boolean; history?: string[] } = {}): Promise<string> {
  const q = `${cyan("?")} ${bold(prompt)}${def ? " " + dim(`(${o.secret ? "set" : def})`) : ""} ${cyan("›")} `;
  if (!isTTY()) { process.stdout.write(q + "\n"); return (await nextLine())?.trim() || def; }
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, terminal: true, escapeCodeTimeout: 40, history: o.history ? [...o.history] : undefined, historySize: 100 });
  if (o.secret) { const w = (rl as any)._writeToOutput; (rl as any)._writeToOutput = (s: string) => { if (s.includes(q)) w.call(rl, s); }; }
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);                       // settle first: rl.close() fires the "close" handler below
      process.stdin.off("keypress", onKey); rl.close();
      if (o.secret) process.stdout.write("\n");
      err ? reject(err) : resolve(lines.join(o.multiline ? "\n" : " ").trim() || def);
    };
    const onKey = (_s: string | undefined, k: { name?: string }) => { if (k?.name === "escape") { process.stdout.write("\n"); finish(new Cancel()); } };
    process.stdin.on("keypress", onKey);
    // a paste delivers several lines in one tick; collect them before answering
    rl.on("line", (l) => { lines.push(l); clearTimeout(timer); timer = setTimeout(() => finish(), 25); });
    rl.on("close", () => finish());                                // e.g. Ctrl-D: answer with what we have
    rl.setPrompt(q); rl.prompt();
  });
}

export const confirm = async (q: string, def = false) =>
  (await select(q, [{ label: "Yes", value: true }, { label: "No", value: false }], def ? 0 : 1)) ?? false;

export const pause = async () => { try { await ask(dim("press enter to continue"), ""); } catch (e) { if (!(e instanceof Cancel)) throw e; } };

export const clearScreen = () => { if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H"); };

// ---- trace output + ref-counted spinner (parallel model calls share one spinner). The label may be a live function.
const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let spinners = 0, timer: ReturnType<typeof setInterval> | undefined, frame = 0, label: string | (() => string) = "";
export function log(line = "") { process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K${line}\n` : line + "\n"); }
export function spin(text: string | (() => string)): () => void {
  if (!process.stderr.isTTY) return () => {};
  label = text;
  if (spinners++ === 0) timer = setInterval(() => process.stderr.write(`\r\x1b[2K${cyan(frames[frame++ % frames.length])} ${dim(typeof label === "function" ? label() : label)}`), 100);
  let stopped = false;
  return () => { if (stopped) return; stopped = true; if (--spinners === 0) { clearInterval(timer); process.stderr.write("\r\x1b[2K"); } };
}

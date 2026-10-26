// Pure rendering helpers for the chat UI: every function returns terminal lines and never touches the terminal.
import { bold, cyan, dim, gray, green, magenta, red, yellow } from "../ui.ts";
import { renderMarkdown } from "./markdown.ts";
import { TIPS, brandOf, fg, gauge, gaugeColor, logo, toolColor } from "./theme.ts";
import { cellWidth, clipAnsi, clipWidth, strip, wrapAnsi } from "./text.ts";

const ONE = (s: string, n: number) => { const l = s.replace(/\s+/g, " ").trim(); return cellWidth(l) > n ? clipWidth(l, n - 1) + "…" : l; };
const NAMES: Record<string, string> = { read_file: "Read", list_files: "List", grep: "Search", write_file: "Write", edit_file: "Update", sh: "Bash", memory_save: "Memory", memory_search: "Memory",
  memory_forget: "Memory", web_search: "WebSearch", fetch_url: "Fetch", task: "Explore", todo_write: "Todos", exit_plan_mode: "Plan", create_tool: "CreateTool", finish: "Finish" };
export const toolLabel = (name: string) => NAMES[name] ?? name;

/** Short, human description of a tool call's arguments. */
export function argSummary(name: string, raw: string): string {
  let a: any; try { a = JSON.parse(raw); } catch { return ONE(raw, 70); }
  switch (name) {
    case "sh": return ONE(a.cmd ?? "", 90);
    case "read_file": return a.path + (a.start ? `:${a.start}${a.end ? "-" + a.end : ""}` : "");
    case "grep": return `"${ONE(a.pattern ?? "", 40)}"${a.path ? " in " + a.path : ""}`;
    case "list_files": return a.path ?? ".";
    case "task": return ONE(a.description ?? "", 70);
    case "web_search": return ONE(a.query ?? "", 70);
    case "fetch_url": return ONE(a.url ?? "", 80);
    case "memory_save": return a.name ?? "";
    case "todo_write": return `${a.todos?.length ?? 0} items`;
    case "exit_plan_mode": return "";
  }
  const named = a.path ?? a.name ?? a.query ?? a.description;
  if (typeof named === "string") return ONE(named, 80);
  const entries = Object.entries(a ?? {});                                          // unknown tool (e.g. from MCP): show its arguments compactly
  if (entries.length === 1) return ONE(typeof entries[0][1] === "string" ? entries[0][1] : JSON.stringify(entries[0][1]), 80);
  return ONE(entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", "), 80);
}

export const toolCall = (name: string, raw: string) => `${bold(toolLabel(name))}${dim("(")}${argSummary(name, raw)}${dim(")")}`;
export const toolHeader = (name: string, raw: string, ok: boolean | null = null, agent?: string) =>
  `${agent && agent !== "lead" ? dim("  │ ") : ""}${ok === false ? red("●") : fg(toolColor(name), "●")} ${toolCall(name, raw)}`;      // colour says what kind of work it was; red says it failed

export const isFailure = (result: string) => /^(ERROR|DENIED|REJECTED)/.test(result) || /^exit=(?!0\b)/.test(result);
const more = (n: number, hint = true) => dim(`… +${n} more line${n > 1 ? "s" : ""}${hint ? " (ctrl+o to view all)" : ""}`);
const hang = (lines: string[], first = "  ⎿  ", rest = "     ") => lines.map((l, i) => dim(i ? rest : first) + l);

/** Result lines shown under a tool header (the "⎿" block). */
export function toolResult(name: string, raw: string, result: string, width: number): string[] {
  const body = result.split("\n"), w = width - 5;
  const lines = result.trim() ? body : [];
  if (isFailure(result)) {
    const shown = body.filter(Boolean).slice(0, 6).map((l) => red(ONE(l, w)));
    return hang([...shown, ...(body.filter(Boolean).length > 6 ? [more(body.filter(Boolean).length - 6)] : [])]);
  }
  switch (name) {
    case "read_file": return hang([dim(`Read ${lines.length} line${lines.length === 1 ? "" : "s"}`)]);
    case "list_files": return hang([dim(`${lines.filter(Boolean).length} file${lines.length === 1 ? "" : "s"}`)]);
    case "grep": {
      if (/^no matches/.test(result)) return hang([dim("No matches")]);
      const hits = lines.filter(Boolean), files = new Set(hits.map((l) => l.split(":")[0]));
      return hang([dim(`${hits.length} match${hits.length === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"}`)]);
    }
    case "sh": {
      const out = body.slice(1).filter((l, i, a) => l.trim() || i < a.length - 1), shown = out.slice(0, 8).map((l) => gray(ONE(l, w)));
      return hang(out.length ? [...shown, ...(out.length > 8 ? [more(out.length - 8)] : [])] : [dim("(no output)")]);
    }
    case "write_file": case "edit_file": return [];                                   // the diff block is rendered from the edit event
    case "memory_save": case "memory_forget": return hang([dim(ONE(result, w))]);
    case "web_search": return hang([dim(`${(result.match(/^\d+\./gm) ?? []).length} results`)]);
    case "fetch_url": return hang([dim(`${result.length.toLocaleString()} characters`)]);
    case "task": { const t = result.split("\n").filter(Boolean); return hang([...t.slice(0, 8).map((l) => ONE(l, w)), ...(t.length > 8 ? [more(t.length - 8)] : [])]); }
    case "todo_write": case "exit_plan_mode": return [];
  }
  const t = lines.filter(Boolean);
  return t.length ? hang([ONE(t[0], w), ...(t.length > 1 ? [more(t.length - 1)] : [])]) : [];
}

/** Unified diff with line numbers and +/- colouring, like an editor's change view. */
export function renderDiff(diff: string, width: number, maxLines = 24): string[] {
  const out: string[] = [];
  let a = 0, b = 0;
  const body = diff.split("\n").filter((l) => !/^(---|\+\+\+)/.test(l));
  const numW = String(Math.max(a, ...body.map((l) => { const m = l.match(/^@@ -(\d+),?\d* \+(\d+)/); return m ? Math.max(+m[1], +m[2]) + 400 : 0; })) || 1).length;
  for (const l of body) {
    const h = l.match(/^@@ -(\d+),?\d* \+(\d+)/);
    if (h) { a = +h[1]; b = +h[2]; if (out.length) out.push(dim("      ⋮")); continue; }
    if (!l) continue;
    const t = l[0], text = l.slice(1), room = Math.max(10, width - numW - 8);
    const shown = cellWidth(text) > room ? clipWidth(text, room - 1) + "…" : text;
    if (t === "+") out.push(green(`${String(b).padStart(numW)} + ${shown}`)), b++;
    else if (t === "-") out.push(red(`${String(a).padStart(numW)} - ${shown}`)), a++;
    else out.push(gray(`${String(b).padStart(numW)}   ${shown}`)), a++, b++;
  }
  const clipped = out.length > maxLines ? [...out.slice(0, maxLines), more(out.length - maxLines)] : out;
  return clipped.map((l) => "     " + l);
}

export const editSummary = (e: { created: boolean; added: number; removed: number }) =>
  e.created ? `Created with ${e.added} line${e.added === 1 ? "" : "s"}` : `Added ${e.added} line${e.added === 1 ? "" : "s"}, removed ${e.removed} line${e.removed === 1 ? "" : "s"}`;

export function userMessage(text: string, width: number, note = ""): string[] {
  const rows = text.split("\n").flatMap((l, i) => wrapAnsi(l, width - 2, 0).map((r, j) => (i === 0 && j === 0 ? bold(cyan("❯ ")) : "  ") + bold(r)));
  return ["", ...rows, ...(note ? ["  " + dim(note)] : [])];
}

/** One assistant block: first block of a message gets the "●" marker; later blocks are separated by a blank line. */
export function assistantBlock(md: string, width: number, first: boolean): string[] {
  const rows = renderMarkdown(md, width - 2);
  if (!rows.length) return [];
  return [...(first ? [] : [""]), ...rows.map((r, i) => (first && i === 0 ? "● " : "  ") + r)].map((r, i) => (first && i === 0 ? r.replace("●", bold("●")) : r));
}

export function todoList(todos: { content: string; status: string }[], width: number): string[] {
  if (!todos.length) return [];
  const done = todos.filter((t) => t.status === "done").length;
  return [dim(`  ☰ Todos ${done}/${todos.length}`), ...todos.slice(0, 10).map((t) =>
    "    " + (t.status === "done" ? green("☒ ") + dim(strike(ONE(t.content, width - 8))) : t.status === "in_progress" ? yellow("▶ ") + bold(ONE(t.content, width - 8)) : "☐ " + ONE(t.content, width - 8))),
  ...(todos.length > 10 ? [dim(`    … +${todos.length - 10} more`)] : [])];
}
const strike = (s: string) => `\x1b[9m${s}\x1b[29m`;

export type Option = { label: string; hint?: string };
/** Numbered, arrow-selectable option list used by approval prompts and pickers. */
export function optionList(opts: Option[], sel: number): string[] {
  return opts.map((o, i) => `${i === sel ? cyan("❯") : " "} ${i === sel ? bold(cyan(`${i + 1}.`)) : dim(`${i + 1}.`)} ${i === sel ? bold(o.label) : o.label}${o.hint ? "  " + dim(o.hint) : ""}`);
}

export function framed(title: string, body: string[], width: number, paint: (s: string) => string = cyan): string[] {
  const inner = width - 4, rows = body.flatMap((l) => wrapAnsi(l, inner));
  const top = paint("╭─ ") + bold(title) + paint(" " + "─".repeat(Math.max(0, width - 5 - cellWidth(strip(title)))) + "╮");
  return [top, ...rows.map((r) => paint("│ ") + r + " ".repeat(Math.max(0, inner - cellWidth(r))) + paint(" │")), paint("╰" + "─".repeat(width - 2) + "╯")];
}

export type FooterInfo = { mode: string; model: string; provider?: string; ctxPct: number | null; cost: string; branch?: string; hint?: string; /** no left-hand hints at all (a prompt owns the screen) */ quiet?: boolean; /** transient message, shown in place of the hint without hiding the mode */ notice?: string; running?: boolean; queued?: number };
const MODE_LABEL: Record<string, string> = { default: "", acceptEdits: "⏵⏵ accept edits on", plan: "⏸ plan mode (read-only)", yolo: "⚠ yolo: no permission prompts" };
export function footer(f: FooterInfo, width: number): string {
  const m = MODE_LABEL[f.mode] ?? f.mode;
  const left = [m ? (f.mode === "yolo" ? red(m) : f.mode === "plan" ? yellow(m) : green(m)) : "", f.notice ? yellow(f.notice) : f.hint ? dim(f.hint) : ""].filter(Boolean).join(dim("  ·  ")) || (f.quiet ? "" : dim("? for shortcuts"));
  const brand = brandOf(f.model, f.provider), ctx = f.ctxPct !== null ? `${gauge(f.ctxPct, 8)} ${fg(gaugeColor(f.ctxPct), f.ctxPct + "%")}` : "";
  const right = [f.queued ? yellow(`${f.queued} queued`) : "", f.branch ? dim("⎇ " + f.branch) : "", `${fg(brand.color, brand.icon)} ${dim(f.model)}`, ctx, f.cost ? dim(f.cost) : ""].filter(Boolean).join(dim(" · "));
  const avail = width - cellWidth(right) - 4;                                   // the right-hand info (queue, model, context) wins over the hints on the left
  if (avail < 8) return " " + clipAnsi(left, width - 2);
  const L = cellWidth(left) > avail ? clipAnsi(left, avail) : left;
  return " " + L + " ".repeat(Math.max(2, width - cellWidth(L) - cellWidth(right) - 2)) + right;
}

export const COMMAND_HELP_WIDTH = 14;
export function helpLines(cmds: { name: string; help: string }[], width: number): string[] {
  const keys: [string, string][] = [["Enter", "send · queue while working"], ["\\ + Enter / Alt+Enter / Ctrl+J", "new line"], ["Esc", "interrupt · close popup · Esc Esc rewind"],
    ["Ctrl+C", "interrupt · clear input · exit (twice)"], ["Shift+Tab", "cycle permissions: ask → accept edits → plan"], ["↑ ↓", "history · menu"], ["Tab", "accept suggestion"],
    ["@path", "mention a file"], ["!cmd", "run a shell command now"], ["#note", "remember a note"], ["Ctrl+P", "command palette"], ["Alt+M", "switch model"], ["Ctrl+O", "full transcript"], ["Ctrl+L", "redraw"]];
  return [bold("Keys"), ...keys.map(([k, d]) => `  ${cyan(k.padEnd(31))} ${dim(d)}`), "", bold("Commands"),
    ...cmds.map((c) => `  ${cyan(("/" + c.name).padEnd(COMMAND_HELP_WIDTH))} ${dim(c.help)}`)].flatMap((l) => wrapAnsi(l, width - 2, 33));
}

export function welcome(o: { version: string; model: string; provider?: string; cwd: string; branch?: string; notes: number; verify?: string; mode: string; resumed?: string; tip?: string }, width: number): string[] {
  const home = process.env.HOME ?? "";
  let cwd = home && o.cwd.startsWith(home) ? "~" + o.cwd.slice(home.length) : o.cwd;
  const room = Math.min(width, 66) - 4 - 9 - (o.branch ? o.branch.length + 4 : 0);        // keep "project  path  ⎇ branch" on one line
  if (cellWidth(cwd) > room) cwd = "…" + cwd.slice(cwd.length - Math.max(8, room - 1));
  const b = brandOf(o.model, o.provider);
  const body = [
    ...logo(o.version), "",
    `${dim("model")}    ${fg(b.color, b.icon)} ${bold(o.model)}`, `${dim("project")}  ${cwd}${o.branch ? dim("  ⎇ " + o.branch) : ""}`,
    ...(o.verify ? [`${dim("verify")}   ${o.verify}`] : []), ...(o.notes ? [`${dim("memory")}   ${o.notes} note${o.notes === 1 ? "" : "s"} loaded`] : []),
    ...(o.resumed ? [`${dim("resumed")}  ${o.resumed}`] : []),
  ];
  return [...framed("welcome", body, Math.min(width, 66)), ...wrapAnsi(dim("  /help for commands · @file to mention · shift+tab changes permissions"), width, 2),
    ...(o.tip ? wrapAnsi(`  ${yellow("tip")} ${dim(o.tip)}`, width, 6) : []), ""];
}

// Card renderers for the full-screen transcript: each block becomes rows of styled cells exactly `ctx.width` wide.
import type { Block } from "./blocks.ts";
import { type Cell, mix, parseAnsi } from "./ansi.ts";
import { langOf, renderDiffRows } from "./diffview.ts";
import { highlightWith, renderMarkdown, type HlKind } from "./markdown.ts";
import { B, BOLD, F, ITAL, chip, fit, split, themeSkin } from "./rich.ts";
import { cellWidth, clipWidth, strip, wrapAnsi } from "./text.ts";
import type { Theme } from "./themes.ts";
import { toolLabel, argSummary } from "./view.ts";
import { codeBlocks } from "./clipboard.ts";

export type RenderCtx = {
  theme: Theme; width: number; now: number; frame: number; expandAll: boolean; live: boolean;
  /** the steps a subagent card ran (full-screen view nests them inside the card) */ kids?: (callId: string) => ToolBlock[];
  brand: { icon: string; color: number }; diffMode: "auto" | "stacked" | "split";
  /** The block above is also a tool call: draw no blank line between them, so a run of tool calls reads as one unit. */
  tight?: boolean;
  /** this is the most recent tool call of the lead agent: its output stays open (a short preview) until the next one starts */
  last?: boolean;
};
export type Hit = { row: number; x0: number; x1: number; kind: "toggle" | "more" | "copy"; id: number; /** for "copy": what lands on the clipboard */ text?: string };
export type Rendered = { rows: Cell[][]; hits: Hit[]; text: string[] };

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const MARGIN = 2;
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

/** Short, honest one-line summary of a tool result for the card header. */
export function summarize(name: string, raw: string, result: string): string {
  const lines = result.split("\n"), count = (re = /./) => lines.filter((l) => re.test(l)).length;
  switch (name) {
    case "read_file": return `${count()} line${count() === 1 ? "" : "s"}`;
    case "list_files": return `${count()} file${count() === 1 ? "" : "s"}`;
    case "grep": { if (/^no matches/.test(result)) return "no matches"; const hits = lines.filter(Boolean), files = new Set(hits.map((l) => l.split(":")[0])); return `${hits.length} match${hits.length === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"}`; }
    case "sh": return (lines[0] ?? "").replace("exit=", "exit ");
    case "web_search": return `${(result.match(/^\d+\./gm) ?? []).length} results`;
    case "fetch_url": return `${result.length.toLocaleString()} chars`;
    case "task": return "done";
    case "memory_save": case "memory_forget": return strip(result).slice(0, 40);
    default: return strip(lines.find(Boolean) ?? "").slice(0, 44);
  }
}

type ToolBlock = Extract<Block, { kind: "tool" }>;
/** Tool calls that only look at things. A run of them collapses into one "Explored" row; edits, commands and failures always stand alone. */
export const isQuiet = (b: Block): b is ToolBlock => b.kind === "tool" && (!b.agent || b.agent === "lead") && b.status !== "fail" && !b.edit && ["read_file", "list_files", "grep", "web_search", "fetch_url", "memory_search"].includes(b.name);

/** "3 files read · 2 searches": what a group of quiet tool calls did, in one phrase. */
export function groupSummary(bs: ToolBlock[]): string {
  const n = (names: string[]) => bs.filter((b) => names.includes(b.name)).length, parts: string[] = [];
  const add = (k: number, one: string, many: string) => { if (k) parts.push(`${k} ${k === 1 ? one : many}`); };
  add(n(["read_file"]), "file read", "files read"); add(n(["grep"]), "search", "searches"); add(n(["list_files"]), "listing", "listings");
  add(n(["web_search", "fetch_url"]), "web lookup", "web lookups"); add(n(["memory_search"]), "memory lookup", "memory lookups");
  return parts.join(" · ");
}

export function renderGroup(bs: ToolBlock[], open: boolean, c: RenderCtx): Rendered {
  const t = c.theme, bw = c.width - MARGIN * 2, rows: string[] = [], hits: Hit[] = [], bg = t.surface;
  const running = bs.filter((b) => b.status === "running"), cur = running[running.length - 1];
  if (!c.tight) rows.push("");
  const ms = bs.reduce((n, b) => n + (b.ms ?? 0), 0);
  const status = cur ? F(t.accent2, SPIN[c.frame % SPIN.length]) + F(t.dim, ` ${clipWidth(`${toolLabel(cur.name)} ${argSummary(cur.name, cur.args)}`, Math.max(10, bw - 40))}`)
    : F(t.ok, "✓ ") + F(t.dim, `${bs.length} steps`) + (ms >= 50 ? F(t.faint, ` · ${fmtMs(ms)}`) : "");
  rows.push(split(` ${F(t.faint, open ? "▾" : "▸")} ${F(t.tool.read, "●")} ${BOLD(F(t.text, cur ? "Exploring" : "Explored"))}  ${F(t.dim, groupSummary(bs))}`, status + " ", bw, bg));
  hits.push({ row: rows.length - 1, x0: MARGIN, x1: c.width - MARGIN, kind: "toggle", id: bs[0].id });
  if (open) for (const b of bs) {
    const res = b.status === "running" ? F(t.accent2, "…") : F(t.faint, summarize(b.name, b.args, b.result ?? ""));
    rows.push(fit(`   ${F(t.faint, "│")} ${F(t.dim, toolLabel(b.name).padEnd(7))} ${F(t.text, clipWidth(argSummary(b.name, b.args), bw - 30))}  ${res}`, bw, t.bg));
  }
  const cells = rows.map((r) => padLeft(parseAnsi(" ".repeat(MARGIN) + r), c.width));
  return { rows: cells, hits, text: cells.map((r) => r.map((x) => x.ch).join("").replace(/\s+$/, "")) };
}

export function renderBlock(b: Block, c: RenderCtx): Rendered {
  const t = c.theme, bw = c.width - MARGIN * 2, rows: string[] = [], hits: Hit[] = [];
  const blank = () => rows.push("");
  const done = (): Rendered => {
    const cells = rows.map((r) => padLeft(parseAnsi(" ".repeat(MARGIN) + r), c.width));
    return { rows: cells, hits, text: cells.map((r) => r.map((x) => x.ch).join("").replace(/\s+$/, "")) };
  };

  if (b.kind === "user") {
    blank();
    const inner = bw - 4, bar = F(t.accent, "▎"), lines = b.text.split("\n").flatMap((l) => wrapAnsi(l, inner, 0));
    rows.push(fit(bar, bw, t.surface2));
    lines.forEach((l, i) => rows.push(i === 0 && b.queued ? split(`${bar} ${F(t.text, l)}`, chip("queued", t.onAccent, t.warn), bw, t.surface2) : fit(`${bar} ${F(t.text, l)}`, bw, t.surface2)));
    if (b.note) rows.push(fit(`${bar} ${F(t.faint, ITAL(b.note))}`, bw, t.surface2));
    rows.push(fit(bar, bw, t.surface2));
    return done();
  }

  if (b.kind === "assistant") {
    blank();
    const md = renderMarkdown(b.text || " ", bw - 3, themeSkin(t));
    const cursor = b.streaming && c.live && Math.floor(c.frame / 4) % 2 === 0 ? F(t.accent, "▍") : "";
    (md.length ? md : [""]).forEach((l, i) => rows.push((i === 0 ? F(c.brand.color, BOLD(c.brand.icon)) + "  " : "   ") + l + (i === md.length - 1 || md.length === 0 ? cursor : "")));
    // each code block's "copy" label is a button: find its header rows (in order) and pair them with the fenced blocks of the source
    const codes = codeBlocks(b.text); let k = 0;
    md.forEach((l, i) => { if (k < codes.length && /^ ?[\w+#.-]+\s+copy\s*$/.test(strip(l))) hits.push({ row: rows.length - md.length + i, x0: MARGIN + 3 + bw - 3 - 6, x1: MARGIN + bw, kind: "copy", id: b.id, text: codes[k++] }); });
    return done();
  }

  if (b.kind === "summary") {
    blank();
    const md = renderMarkdown(b.text, bw - 6, themeSkin(t));
    rows.push(fit(F(t.ok, "▎") + " " + chip("✓ done", t.onAccent, t.ok, true), bw, t.surface));
    md.forEach((l) => rows.push(fit(F(t.ok, "▎") + "  " + l, bw, t.surface)));
    rows.push(fit(F(t.ok, "▎"), bw, t.surface));
    return done();
  }

  if (b.kind === "notice") {
    const col = b.level === "error" ? t.err : b.level === "warn" ? t.warn : b.level === "ok" ? t.ok : t.dim, icon = b.level === "error" ? "✗" : b.level === "warn" ? "⚠" : b.level === "ok" ? "✓" : "·";
    if (b.level === "info") rows.push("");
    for (const l of wrapAnsi(b.text, bw - 4, 0)) rows.push(b.level === "error" ? fit(` ${F(col, icon)} ${F(col, l)}`, bw, mix(t.surface, t.err, 0.12)) : ` ${F(col, icon)} ${F(b.level === "info" ? t.dim : t.text, l)}`);
    return done();
  }

  if (b.kind === "raw") { for (const l of b.lines) rows.push(l); return done(); }

  if (b.kind === "thinking") {
    const open = b.expanded ?? false, label = b.active ? `thinking${".".repeat(1 + (Math.floor(c.frame / 3) % 3))}` : `thought for ${fmtMs(b.ms ?? 0)}`;
    rows.push(`${F(t.faint, open || b.active ? "▾" : "▸")} ${F(t.accent2, "✻")} ${F(t.faint, ITAL(label))}`);
    if (b.active || open) for (const l of wrapAnsi(b.text.replace(/\s+/g, " ").trim(), bw - 6, 0).slice(b.active ? -3 : 0)) rows.push(`    ${F(t.faint, ITAL(l))}`);
    hits.push({ row: 0, x0: MARGIN, x1: c.width - MARGIN, kind: "toggle", id: b.id });
    return done();
  }

  // ---------------------------------------------------------------- tool card
  const sub = !!b.agent && b.agent !== "lead", failed = b.status === "fail", edit = b.edit;
  const hue = failed ? t.err : (({ read_file: t.tool.read, list_files: t.tool.read, grep: t.tool.read, write_file: t.tool.edit, edit_file: t.tool.edit, apply_patch: t.tool.edit, sh: t.tool.shell, web_search: t.tool.web, fetch_url: t.tool.web, memory_save: t.tool.memory, memory_forget: t.tool.memory, memory_search: t.tool.read, todo_write: t.tool.plan, exit_plan_mode: t.tool.plan, task: t.tool.explore }) as Record<string, number>)[b.name] ?? (b.name.includes("__") ? t.tool.web : t.tool.generic);
  const expanded = c.expandAll ? true : b.expanded ?? (!!edit || failed || (!!c.last && !sub && b.name !== "read_file" && b.name !== "task"));
  const preview = !c.expandAll && b.expanded === undefined && !edit && !failed && !!c.last && b.name !== "read_file" && b.name !== "task";   // opened automatically, not by the user: show a short preview only
  const bg = failed ? mix(t.surface, t.err, 0.14) : t.surface, spinner = SPIN[c.frame % SPIN.length];
  const label = BOLD(F(failed ? t.err : t.text, toolLabel(b.name))), args = F(t.dim, argSummary(b.name, b.args));
  const status = b.status === "running"
    ? F(t.accent2, spinner) + F(t.dim, ` ${fmtMs(c.now - b.t0)}`)
    : edit ? (edit.created ? chip("new", t.onAccent, t.ok) + " " : "") + F(t.addFg, `+${edit.added}`) + " " + F(t.delFg, `−${edit.removed}`) + (b.ms !== undefined && b.ms >= 50 ? F(t.faint, ` · ${fmtMs(b.ms)}`) : "")
    : F(failed ? t.err : t.ok, failed ? "✗ " : "✓ ") + F(failed ? t.err : t.dim, summarize(b.name, b.args, b.result ?? "")) + (b.ms !== undefined && b.ms >= 50 ? F(t.faint, ` · ${fmtMs(b.ms)}`) : "");
  const kids = !sub && b.name === "task" ? c.kids?.(b.callId) ?? [] : [];
  const hasBody = (b.status !== "running" || kids.length > 0) && !!(edit || kids.length || (b.result && b.result.trim()));
  const caret = F(t.faint, hasBody ? (expanded ? "▾" : "▸") : " ");
  if (!sub && (!c.tight || (hasBody && expanded))) blank();   // collapsed one-liners stack tightly; a card with a body gets air above it
  const head = `${caret} ${F(hue, "●")} ${label}  ${args}`;
  rows.push(sub ? `   ${F(t.faint, "│")} ${F(hue, "●")} ${F(t.dim, toolLabel(b.name))} ${F(t.faint, argSummary(b.name, b.args))}` : split(" " + head, status + " ", bw, bg));
  if (!sub && hasBody) hits.push({ row: rows.length - 1, x0: MARGIN, x1: c.width - MARGIN, kind: "toggle", id: b.id });

  if (kids.length) {                                       // a subagent's steps, inside its own card: the newest few while it runs, a one-line summary when done, all of them when opened
    const line = (k: ToolBlock) => fit(`   ${F(t.faint, "│")} ${k.status === "running" ? F(t.accent2, spinner) : k.status === "fail" ? F(t.err, "✗") : F(t.ok, "✓")} ${F(t.dim, toolLabel(k.name).padEnd(7))} ${F(t.text, clipWidth(argSummary(k.name, k.args), bw - 24))}`, bw, t.bg);
    const running = b.status === "running", shown = expanded ? kids : running ? kids.slice(-3) : [];
    if (!expanded && running && kids.length > 3) rows.push(fit(`   ${F(t.faint, "│ … " + (kids.length - 3) + " earlier step" + (kids.length - 3 === 1 ? "" : "s"))}`, bw, t.bg));
    for (const k of shown) rows.push(line(k));
    if (!running && !expanded) rows.push(fit(`   ${F(t.faint, "│")} ${F(t.dim, `${kids.length} step${kids.length === 1 ? "" : "s"} · ${groupSummary(kids) || "no lookups"}`)}  ${F(t.faint, "(click to see them)")}`, bw, t.bg));
  }
  if (!sub && hasBody && expanded && (edit || (b.result && b.result.trim()))) {
    const bar = F(hue, "▏"), body = (s: string) => rows.push(fit(bar + " " + s, bw, bg));
    if (edit) {
      const mode = c.diffMode === "auto" ? (bw >= 120 ? "split" : "stacked") : c.diffMode, max = b.more ? Infinity : 16;
      const d = renderDiffRows(edit.diff, { width: bw - 2, theme: t, lang: langOf(edit.path), mode, maxRows: max });
      for (const r of d.rows) rows.push(bar + " " + r);
      if (d.hidden > 0) { rows.push(fit(`${bar}  ${F(t.accent2, `▾ show ${d.hidden} more line${d.hidden === 1 ? "" : "s"}`)}`, bw, t.surface2)); hits.push({ row: rows.length - 1, x0: MARGIN, x1: c.width - MARGIN, kind: "more", id: b.id }); }
    } else {
      const res = b.result ?? "", hl = (k: HlKind, s: string) => F(k === "plain" ? t.syn.plain : t.syn[k], s);
      let lines = res.split("\n"), cap = c.expandAll ? 200 : preview ? 20 : 60;
      if (b.name === "sh") {
        let cmd = ""; try { cmd = JSON.parse(b.args).cmd; } catch { /* leave empty */ }
        body(F(t.accent, "$ ") + F(t.text, clipWidth(cmd, bw - 8)));
        lines = lines.slice(1);
        if (!lines.some((l) => l.trim())) lines = [F(t.faint, "(no output)")];
      }
      const lang = b.name === "read_file" ? (() => { try { return langOf(JSON.parse(b.args).path); } catch { return ""; } })() : "";
      for (const l of lines.slice(0, cap)) {
        if (b.name === "read_file") { const m = l.match(/^(\d+)\t(.*)$/); body(m ? F(t.faint, m[1].padStart(4) + "  ") + highlightWith(clipWidth(m[2], bw - 10), lang, hl) : F(t.dim, l)); }
        else for (const w of wrapAnsi(l.includes("\x1b") ? l : F(failed && /error|✖|fail|exception|assert|panic|traceback|denied/i.test(l) ? t.err : t.dim, l), bw - 4, 0)) body(w);   // only the lines that look like errors are red
      }
      if (lines.length > cap) body(F(t.faint, `… ${lines.length - cap} more line${lines.length - cap === 1 ? "" : "s"} · /output shows all of it${preview ? "" : " · ctrl+o expands everything"}`));
    }
  }
  return done();
}

/** Pad or clip a cell row to exactly `width` cells (default-background padding, so the canvas background shows through). */
function padLeft(cells: Cell[], width: number): Cell[] {
  const out: Cell[] = []; let w = 0;
  for (const c of cells) { if (w + c.w > width) break; out.push(c); w += c.w; }
  while (w < width) { out.push({ ch: " ", w: 1, fg: -1, bg: -1, attr: 0 }); w++; }
  return out;
}
void cellWidth;

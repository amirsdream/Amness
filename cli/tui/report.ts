// Reports as structured content (key/value rows, tables, lists, meters, code), not pre-styled terminal text. Each front end draws them in its
// own style: the terminal as aligned, coloured lines (renderBlocks), the desktop as real HTML (cli/desktop/ui/app.js, `report` blocks).
// `plainBlocks` gives the plain text, for Copy and for API clients.
import { bold, cyan, dim, green, red, yellow } from "../ui.ts";
import { A } from "./ansi.ts";
import { cellWidth, clipWidth, wrapAnsi } from "./text.ts";

export type Tone = "ok" | "warn" | "err" | "accent" | "muted";
export type ReportBlock =
  /** label / value rows; a value may carry a tone and a muted hint after it */
  | { kind: "kv"; title?: string; rows: { key: string; value: string; tone?: Tone; hint?: string }[] }
  /** rows with columns; the first cell of a row with a tone gets a coloured dot */
  | { kind: "table"; title?: string; columns: string[]; rows: { cells: string[]; tone?: Tone }[] }
  /** items with a status dot, a label, a detail line and an optional badge */
  | { kind: "list"; title?: string; items: { label: string; detail?: string; badge?: string; tone?: Tone }[]; empty?: string }
  /** a 0-100 gauge, as a row of a key/value list */
  | { kind: "meter"; label: string; pct: number; detail?: string }
  /** a stacked bar of parts (what fills the context), colours as 0xRRGGBB */
  | { kind: "segments"; label: string; parts: { label: string; pct: number; color: number }[] }
  /** values over time, newest last */
  | { kind: "spark"; label: string; values: number[]; detail?: string }
  | { kind: "text"; title?: string; text: string; tone?: Tone }
  | { kind: "code"; title?: string; lang: "json" | "text"; text: string }
  /** a muted line at the end: the commands that go with a report */
  | { kind: "note"; text: string; tone?: Tone };

const toneFn = (t?: Tone) => (t === "ok" ? green : t === "warn" ? yellow : t === "err" ? red : t === "accent" ? cyan : t === "muted" ? dim : (s: string) => s);
const DOT = "●";
const fgHex = (c: number, s: string) => `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m${s}\x1b[39m`;
const gauge = (pct: number, w = 20) => { const f = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w); return (pct >= 85 ? red : pct >= 60 ? yellow : green)("▰".repeat(f)) + dim("▱".repeat(w - f)); };
const SPARK = "▁▂▃▄▅▆▇█";
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - cellWidth(s)));
/** JSON with colours (keys, strings, numbers), one string per line. */
export function jsonLines(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:)/, (_m, sp, k, c) => sp + cyan(k) + c).replace(/(:\s*|^\s*)("(?:[^"\\]|\\.)*")(,?)$/, (_m, pre, v, c) => pre + green(v) + c).replace(/(:\s*|^\s*)(-?\d+(?:\.\d+)?|true|false|null)(,?)$/, (_m, pre, n, c) => pre + yellow(n) + c));
}

/** The terminal's drawing of a report: two-space margin, muted keys aligned in a column, a bold title over each section. */
export function renderBlocks(blocks: ReportBlock[], width = 100): string[] {
  const out: string[] = [], w = Math.max(40, width - 4);
  // keys of neighbouring kv rows, meters, segments and sparks line up in one column
  const keyW = Math.min(22, Math.max(8, ...blocks.flatMap((b) => (b.kind === "kv" ? b.rows.map((r) => cellWidth(r.key)) : b.kind === "meter" || b.kind === "segments" || b.kind === "spark" ? [cellWidth(b.label)] : []))));
  const section = (title?: string) => { if (title) { if (out.length) out.push(""); out.push("  " + bold(title)); } };
  for (const b of blocks) {
    if (b.kind === "kv") { section(b.title); for (const r of b.rows) { const v = toneFn(r.tone)(r.value) + (r.hint ? dim(`  ${r.hint}`) : ""); wrapAnsi(v, w - keyW - 2, 0).forEach((l, i) => out.push("  " + (i ? " ".repeat(keyW) : dim(pad(r.key, keyW))) + "  " + l)); } }
    else if (b.kind === "meter") out.push("  " + dim(pad(b.label, keyW)) + "  " + gauge(b.pct) + " " + (b.pct >= 85 ? red : b.pct >= 60 ? yellow : green)(`${b.pct}%`) + (b.detail ? dim(`  ${b.detail}`) : ""));
    else if (b.kind === "segments") {
      const bw = Math.max(16, Math.min(48, w - keyW - 4)); let bar = "", used = 0;
      b.parts.forEach((p, i) => { const n = i === b.parts.length - 1 ? bw - used : Math.round((p.pct / 100) * bw); if (n > 0) { bar += fgHex(p.color, "█".repeat(n)); used += n; } });
      out.push("  " + dim(pad(b.label, keyW)) + "  " + bar);
      const legend = b.parts.filter((p) => p.pct > 0).map((p) => fgHex(p.color, "■") + ` ${p.label} ${p.pct}%`).join("   ");
      for (const l of wrapAnsi(legend, w - keyW - 2, 0)) out.push("  " + " ".repeat(keyW) + "  " + l);
    }
    else if (b.kind === "spark") { const v = b.values.slice(-32), mx = Math.max(1, ...v); out.push("  " + dim(pad(b.label, keyW)) + "  " + cyan(v.map((x) => SPARK[Math.min(7, Math.round((x / mx) * 7))]).join("")) + (b.detail ? dim(`  ${b.detail}`) : "")); }
    else if (b.kind === "table") {
      section(b.title);
      const cols = b.columns.length, widths = b.columns.map((c, i) => Math.min(i === cols - 1 ? 200 : 32, Math.max(cellWidth(c), ...b.rows.map((r) => cellWidth(r.cells[i] ?? "")))));
      const dot = b.rows.some((r) => r.tone) ? 2 : 0, last = Math.max(10, w - dot - widths.slice(0, -1).reduce((n, x) => n + x + 2, 0));
      const line = (cells: string[], head: boolean, tone?: Tone) => "  " + (dot ? (tone ? toneFn(tone)(DOT) + " " : "  ") : "") + cells.map((c, i) => { const cw = i === cols - 1 ? last : widths[i], t = clipWidth(c, cw); return head ? dim(i === cols - 1 ? t : pad(t, cw)) : i === 0 ? (i === cols - 1 ? t : pad(t, cw)) : i === cols - 1 ? t : pad(t, cw); }).join("  ");
      out.push(line(b.columns, true)); for (const r of b.rows) out.push(line(r.cells, false, r.tone));
    }
    else if (b.kind === "list") {
      section(b.title);
      if (!b.items.length && b.empty) out.push("  " + dim(b.empty));
      for (const it of b.items) {
        out.push("  " + toneFn(it.tone ?? "muted")(DOT) + " " + bold(it.label) + (it.badge ? "  " + dim(`[${it.badge}]`) : ""));
        if (it.detail) for (const l of wrapAnsi(dim(it.detail), w - 4, 0)) out.push("    " + l);
      }
    }
    else if (b.kind === "text") { section(b.title); for (const p of b.text.split("\n")) for (const l of wrapAnsi(toneFn(b.tone)(p), w, 0)) out.push("  " + l); }
    else if (b.kind === "code") { section(b.title); for (const l of b.lang === "json" ? jsonLines(b.text) : b.text.split("\n")) out.push("  " + l); }
    else if (b.kind === "note") { out.push(""); for (const l of wrapAnsi(toneFn(b.tone ?? "muted")(b.text), w, 0)) out.push("  " + l); }
  }
  void A;
  return out;
}

/** The report as plain text: for Copy, for `amness serve` and the desktop's quiet commands. */
export function plainBlocks(blocks: ReportBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if ("title" in b && b.title) out.push("", b.title);
    if (b.kind === "kv") for (const r of b.rows) out.push(`${r.key}: ${r.value}${r.hint ? ` (${r.hint})` : ""}`);
    else if (b.kind === "meter") out.push(`${b.label}: ${b.pct}%${b.detail ? ` (${b.detail})` : ""}`);
    else if (b.kind === "segments") out.push(`${b.label}: ${b.parts.filter((p) => p.pct > 0).map((p) => `${p.label} ${p.pct}%`).join(", ")}`);
    else if (b.kind === "spark") out.push(`${b.label}: ${b.detail ?? b.values.join(" ")}`);
    else if (b.kind === "table") { out.push(b.columns.join(" | ")); for (const r of b.rows) out.push(r.cells.join(" | ")); }
    else if (b.kind === "list") { if (!b.items.length && b.empty) out.push(b.empty); for (const it of b.items) out.push(`${it.label}${it.badge ? ` [${it.badge}]` : ""}${it.detail ? `: ${it.detail}` : ""}`); }
    else if (b.kind === "text" || b.kind === "code" || b.kind === "note") out.push(...b.text.split("\n"));
  }
  return out[0] === "" ? out.slice(1) : out;
}

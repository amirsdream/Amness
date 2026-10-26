// Markdown -> ANSI lines for assistant messages, plus block splitting so streamed text can be rendered as it arrives.
// All styling goes through a Skin, so the same parser serves the inline UI (defaultSkin) and the themed full-screen UI.
import { bold, cyan, dim, gray, green, magenta, yellow } from "../ui.ts";
import { cellWidth, clipWidth, strip, wrapAnsi } from "./text.ts";

export type HlKind = "keyword" | "string" | "number" | "comment" | "plain";
export type Skin = {
  bold(s: string): string; italic(s: string): string; strike(s: string): string; code(s: string): string; link(text: string, url: string): string; dim(s: string): string;
  /** styled lines for a heading (may include an underline rule) */
  heading(level: number, text: string, width: number): string[];
  quote(inner: string): string; bullet(marker: string): string; hr(width: number): string;
  /** a whole fenced code block, already framed and highlighted */
  codeBlock(lines: string[], lang: string, width: number): string[];
  table(rows: string[][], width: number): string[];
  /** hook for `inline` text in table cells etc. */
  hl(kind: HlKind, text: string): string;
};

const KW = {
  js: "const let var function return if else for while do import export from as class new async await try catch finally throw type interface extends implements default switch case break continue null undefined true false this typeof instanceof of in void static public private readonly enum",
  py: "def class return if elif else for while import from as with try except finally raise lambda None True False and or not in is pass yield async await global self",
  sh: "if then else elif fi for while do done case esac function in export local echo cd set unset return exit",
  rs: "fn let mut pub struct enum impl trait use mod match if else for while loop return self Self true false const static ref move async await unsafe where type",
  go: "func var const type struct interface package import return if else for range switch case default go defer chan map nil true false select break continue",
  json: "true false null",
};
const FAMILY: Record<string, keyof typeof KW> = { js: "js", javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", java: "js", c: "js", cpp: "js", cs: "js", kt: "js", swift: "js",
  py: "py", python: "py", rb: "py", ruby: "py", sh: "sh", bash: "sh", zsh: "sh", shell: "sh", rs: "rs", rust: "rs", go: "go", json: "json", jsonc: "json" };
const HASH = new Set(["py", "sh", "rb", "yaml", "yml", "toml", "python", "bash", "zsh", "ruby", "shell", "conf", "dockerfile"]);

/** Tiny line-based highlighter: comments, strings, numbers, keywords. `paint` decides how each kind looks. */
export function highlightWith(line: string, lang: string, paint: (k: HlKind, s: string) => string): string {
  const fam = FAMILY[lang.toLowerCase()], kw = fam ? new Set(KW[fam].split(" ")) : new Set<string>();
  const comment = HASH.has(lang.toLowerCase()) ? "#.*$" : fam || !lang ? "\\/\\/.*$" : "$^";
  const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d[\\d_.]*\\b)|(\\b[A-Za-z_$][\\w$]*\\b)`, "g");
  let out = "", last = 0;
  for (let m; (m = re.exec(line)); ) {
    out += paint("plain", line.slice(last, m.index));
    out += m[1] ? paint("comment", m[0]) : m[2] ? paint("string", m[0]) : m[3] ? paint("number", m[0]) : kw.has(m[4]) ? paint("keyword", m[0]) : paint("plain", m[0]);
    last = m.index + m[0].length;
    if (m[0] === "") re.lastIndex++;
  }
  return out + paint("plain", line.slice(last));
}

const red2 = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const defaultSkin: Skin = {
  bold, dim, italic: (s) => `\x1b[3m${s}\x1b[23m`, strike: (s) => `\x1b[9m${s}\x1b[29m`, code: cyan, link: (t, u) => `${t} ${dim("(" + u + ")")}`,
  heading(level, text, width) {
    const t = text, out = [level === 1 ? bold(cyan(t)) : level === 2 ? bold(cyan(t)) : bold(t)];
    if (level <= 2) out.push(gray("─".repeat(Math.min(width, Math.max(8, cellWidth(strip(t)))))));
    return out;
  },
  quote: (inner) => gray("▎ ") + dim(inner), bullet: (m) => cyan(m), hr: (w) => gray("─".repeat(Math.min(w, 60))),
  hl: (k, s) => (k === "comment" ? gray(s) : k === "string" ? green(s) : k === "number" ? yellow(s) : k === "keyword" ? magenta(s) : s),
  codeBlock(body, lang, width) {
    const out: string[] = [];
    if (lang) out.push(gray("  ╭─ ") + dim(lang));
    for (const b of body) {
      const styled = lang === "diff" ? (b.startsWith("+") ? green(b) : b.startsWith("-") ? red2(b) : b.startsWith("@@") ? cyan(b) : gray(b)) : highlightWith(b, lang, defaultSkin.hl);
      for (const r of wrapAnsi(styled, width - 4, 2)) out.push(gray("  │ ") + r);
    }
    if (lang || body.length) out.push(gray("  ╰─"));
    return out;
  },
  table(rows, width) {
    const n = Math.max(...rows.map((r) => r.length)), widths = Array.from({ length: n }, (_, i) => Math.max(...rows.map((r) => cellWidth(inline(r[i] ?? "", defaultSkin)))));
    const total = widths.reduce((a, b) => a + b, 0) + 3 * n + 1;
    if (total > width) return rows.map((r, i) => (i === 0 ? bold(r.join(" | ")) : r.join(" | ")));          // too wide: fall back to plain rows
    const line = (r: string[], head: boolean) => "│ " + widths.map((w, i) => { const c = inline(r[i] ?? "", defaultSkin); return (head ? bold(c) : c) + " ".repeat(w - cellWidth(c)); }).join(" │ ") + " │";
    const rule = (l: string, m: string, r: string) => gray(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
    return [rule("┌", "┬", "┐"), line(rows[0], true), rule("├", "┼", "┤"), ...rows.slice(1).map((r) => line(r, false)), rule("└", "┴", "┘")].map((l) => (l.startsWith("│") ? gray("│") + l.slice(1) : l));
  },
};

/** Back-compat: highlight with the default skin's colours. */
export const highlight = (line: string, lang: string) => highlightWith(line, lang, defaultSkin.hl);

/** Inline spans: `code`, **bold**, *italic*, ~~strike~~, [text](url). Code is protected first so nothing inside it is reformatted. */
export function inline(s: string, skin: Skin = defaultSkin): string {
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => `\x00${codes.push(skin.code(c)) - 1}\x00`);
  s = s.replace(/\[([^\[\]\n]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => skin.link(t, u));
  s = s.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a, b) => skin.bold(a ?? b));
  s = s.replace(/(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g, (_m, a, b) => skin.italic(a ?? b));
  s = s.replace(/~~([^~\n]+)~~/g, (_m, t) => skin.strike(t));
  return s.replace(/\x00(\d+)\x00/g, (_m, i) => codes[Number(i)]);
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-") && l.includes("|");
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function renderMarkdown(src: string, width: number, skin: Skin = defaultSkin): string[] {
  const out: string[] = [], L = src.replace(/\r\n?/g, "\n").split("\n");
  const push = (line: string, indent = 0) => out.push(...wrapAnsi(line, width, indent));
  let blank = false;
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      const lang = fence[3], body: string[] = [];
      for (i++; i < L.length && !/^\s*(`{3,}|~{3,})\s*$/.test(L[i]); i++) body.push(L[i].slice(Math.min(fence[1].length, L[i].length - L[i].trimStart().length)));
      out.push(...skin.codeBlock(body, lang, width));
      blank = false; continue;
    }
    if (!line.trim()) { if (!blank && out.length) out.push(""); blank = true; continue; }
    blank = false;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) { for (const r of skin.heading(h[1].length, inline(h[2], skin), width)) push(r); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(skin.hr(width)); continue; }
    if (line.includes("|") && i + 1 < L.length && isTableSep(L[i + 1])) {
      const rows = [cells(line)]; i += 2;
      for (; i < L.length && L[i].includes("|") && L[i].trim(); i++) rows.push(cells(L[i]));
      i--; out.push(...skin.table(rows, width)); continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { push(skin.quote(inline(q[1], skin)), 2); continue; }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2), marker = /\d/.test(li[2]) ? li[2] : depth % 2 ? "◦" : "•";
      const pad = "  ".repeat(depth);
      push(`${pad}${skin.bullet(marker)} ${inline(li[3], skin)}`, pad.length + cellWidth(marker) + 1); continue;
    }
    push(inline(line, skin));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Split streamed markdown into blocks that are safe to render now (everything up to the last blank line that is not
 * inside a code fence) and the unfinished remainder, which keeps growing.
 */
export function takeCompleteBlocks(buf: string): { done: string; rest: string } {
  const lines = buf.split("\n");
  let fence = false, cut = -1;
  for (let i = 0; i < lines.length - 1; i++) {                       // the last element has no newline yet, so it is never complete
    if (/^\s*(`{3,}|~{3,})/.test(lines[i])) fence = !fence;
    if (!fence && !lines[i].trim() && i > 0) cut = i;
  }
  if (cut < 0) return { done: "", rest: buf };
  return { done: lines.slice(0, cut).join("\n"), rest: lines.slice(cut + 1).join("\n") };
}

export { clipWidth };

// Diff viewer: line numbers, +/- background tints, syntax highlighting, word-level change marks, and a split (side-by-side) layout.
import { highlightWith, type HlKind } from "./markdown.ts";
import { B, F, fit } from "./rich.ts";
import type { Theme } from "./themes.ts";

export type DiffLine = { t: " " | "+" | "-" | "gap"; text: string; a: number; b: number };
const EXT: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "py", rb: "rb", go: "go", rs: "rs", java: "java", c: "c", h: "c", cpp: "cpp", cs: "cs", sh: "sh", bash: "sh", zsh: "sh", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", md: "md", css: "css", html: "html", kt: "kt", swift: "swift" };
export const langOf = (path: string) => EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "";

/** Parse the unified diff text produced by `unifiedDiff` into rows with old/new line numbers; hunks are separated by `gap` rows. */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let a = 0, b = 0;
  for (const l of diff.split("\n")) {
    if (/^(---|\+\+\+)/.test(l)) continue;
    const h = l.match(/^@@ -(\d+),?\d* \+(\d+)/);
    if (h) { if (out.length) out.push({ t: "gap", text: "", a: +h[1], b: +h[2] }); a = +h[1]; b = +h[2]; continue; }
    if (!l) continue;
    const t = l[0] as " " | "+" | "-", text = l.slice(1);
    if (t === "+") out.push({ t, text, a: 0, b: b++ }); else if (t === "-") out.push({ t, text, a: a++, b: 0 }); else out.push({ t: " ", text, a: a++, b: b++ });
  }
  return out;
}

/** For each - line directly followed by an equal number of + lines, the differing middle of each pair (common prefix/suffix trimmed). */
export function wordDiffs(rows: DiffLine[]): Map<number, [number, number]> {
  const marks = new Map<number, [number, number]>();
  for (let i = 0; i < rows.length; ) {
    if (rows[i].t !== "-") { i++; continue; }
    let d = i; while (d < rows.length && rows[d].t === "-") d++;
    let p = d; while (p < rows.length && rows[p].t === "+") p++;
    const nd = d - i, np = p - d;
    if (nd === np && nd > 0) for (let k = 0; k < nd; k++) {
      const x = rows[i + k].text, y = rows[d + k].text;
      let pre = 0; while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
      let suf = 0; while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
      if (pre + suf < Math.min(x.length, y.length) || x.length !== y.length) { marks.set(i + k, [pre, x.length - suf]); marks.set(d + k, [pre, y.length - suf]); }
    }
    i = Math.max(p, i + 1);
  }
  return marks;
}

function paintCode(text: string, lang: string, t: Theme, bg: number, strong: number, mark?: [number, number]): string {
  const hl = (k: HlKind, s: string) => F(k === "plain" ? t.syn.plain : t.syn[k], s);
  const seg = (s: string, bgc: number) => B(bgc, highlightWith(s, lang, hl));
  if (!mark || mark[0] >= mark[1]) return seg(text, bg);
  return seg(text.slice(0, mark[0]), bg) + seg(text.slice(mark[0], mark[1]), strong) + seg(text.slice(mark[1]), bg);
}

export type DiffOpts = { width: number; theme: Theme; lang: string; mode?: "stacked" | "split"; maxRows?: number };
/** Rows (ANSI strings, exactly `width` wide) for a diff body. `hidden` = rows not shown because of maxRows. */
export function renderDiffRows(diff: string, o: DiffOpts): { rows: string[]; hidden: number; total: number } {
  const t = o.theme, rows = parseDiff(diff), marks = wordDiffs(rows), numW = Math.max(3, String(Math.max(0, ...rows.map((r) => Math.max(r.a, r.b)))).length);
  const out: string[] = [];
  const num = (n: number, fgc: number, bg: number) => B(bg, F(fgc, (n ? String(n) : "").padStart(numW) + " "));
  if (o.mode === "split" && o.width >= 100) {
    const lw = Math.floor((o.width - 1) / 2), rw = o.width - 1 - lw, sep = B(t.surface, F(t.border, "│"));
    // pair removed/added lines side by side; context goes to both sides
    type Cell2 = { l?: DiffLine; r?: DiffLine; li?: number; ri?: number };
    const pairs: Cell2[] = [];
    for (let i = 0; i < rows.length; ) {
      const r = rows[i];
      if (r.t === "gap") { pairs.push({ l: r, r }); i++; continue; }
      if (r.t === " ") { pairs.push({ l: r, r, li: i, ri: i }); i++; continue; }
      let d = i; const ds: number[] = [], as: number[] = [];
      while (d < rows.length && rows[d].t === "-") ds.push(d++);
      while (d < rows.length && rows[d].t === "+") as.push(d++);
      for (let k = 0; k < Math.max(ds.length, as.length); k++) pairs.push({ l: ds[k] !== undefined ? rows[ds[k]] : undefined, r: as[k] !== undefined ? rows[as[k]] : undefined, li: ds[k], ri: as[k] });
      i = d;
    }
    const side = (line: DiffLine | undefined, idx: number | undefined, isLeft: boolean) => {
      const half = isLeft ? lw : rw;
      if (!line) return fit("", half, t.surface);
      if (line.t === "gap") return fit(" " + F(t.faint, "⋯"), half, t.surface2);
      const kind = line.t, bg = kind === "-" ? t.delBg : kind === "+" ? t.addBg : t.surface, strong = kind === "-" ? t.delStrong : t.addStrong;
      const n = isLeft ? line.a : line.b, signFg = kind === "-" ? t.delFg : kind === "+" ? t.addFg : t.faint;
      return fit(num(n, kind === " " ? t.faint : signFg, bg) + F(signFg, kind === " " ? "  " : kind + " ") + paintCode(line.text, o.lang, t, bg, strong, idx !== undefined ? marks.get(idx) : undefined), half, bg);
    };
    for (const p of pairs) out.push(side(p.l, p.li, true) + sep + side(p.r, p.ri, false));
  } else {
    rows.forEach((r, i) => {
      if (r.t === "gap") { out.push(fit(F(t.faint, " ".repeat(numW * 2 + 2) + "⋯"), o.width, t.surface2)); return; }
      const bg = r.t === "-" ? t.delBg : r.t === "+" ? t.addBg : t.surface, strong = r.t === "-" ? t.delStrong : t.addStrong;
      const gutter = num(r.a, r.t === "-" ? t.delFg : t.faint, bg) + num(r.b, r.t === "+" ? t.addFg : t.faint, bg);
      const sign = F(r.t === "-" ? t.delFg : r.t === "+" ? t.addFg : t.faint, r.t === " " ? "  " : r.t + " ");
      out.push(fit(gutter + sign + paintCode(r.text, o.lang, t, bg, strong, marks.get(i)), o.width, bg));
    });
  }
  const max = o.maxRows ?? Infinity;
  return { rows: out.slice(0, max), hidden: Math.max(0, out.length - max), total: out.length };
}

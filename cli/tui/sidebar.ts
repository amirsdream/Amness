// The right-hand panel: what is going on in this session at a glance.
import { A, mix, type Cell, parseAnsi } from "./ansi.ts";
import { BOLD, F, ITAL, fit, split } from "./rich.ts";
import { cellWidth, clipWidth } from "./text.ts";
import type { Theme } from "./themes.ts";
import { brandOfModel } from "./brand.ts";
import { fmtCost, fmtTokens } from "./pricing.ts";

export type SidebarData = {
  title: string; model: string; provider: string; api?: string; branch?: string; cwd: string; mode: string; effort?: string;
  ctxPct: number | null; ctxUsed: number; ctxMax: number; series: number[]; map: { label: string; pct: number; color: number }[];
  usage: { prompt: number; completion: number; calls: number; cached: number; reasoning: number }; cost: number | null;
  todos: { content: string; status: string }[]; changes: { path: string; added: number; removed: number; created: boolean; blockId: number }[];
  tools: number; mcp: number; memory: number; running: boolean; elapsedMs: number; tip?: string;
};
export type SideHit = { row: number; kind: "change" | "todos"; blockId?: number };
const BARS = "▁▂▃▄▅▆▇█";

export function renderSidebar(d: SidebarData, t: Theme, width: number, height: number): { rows: Cell[][]; hits: SideHit[] } {
  const inner = width - 4, out: string[] = [], hits: SideHit[] = [], bg = t.surface;
  const push = (s = "") => out.push(fit("  " + s, width - 1, bg));
  const head = (title: string, right = "") => { if (out.length > 1) push(); push(right ? split(F(t.faint, BOLD(title)), right, inner, bg) : F(t.faint, BOLD(title))); };
  const brand = brandOfModel(d.model, d.provider, t);

  push();
  head("SESSION");
  for (const l of wrap(d.title || "New conversation", inner, 2)) push(BOLD(F(t.text, l)));
  push(F(brand.color, brand.icon) + " " + F(t.text, clipWidth(d.model, inner - 4)));
  push(F(t.faint, [d.api ? `${d.api} api` : "", d.effort ? `effort ${d.effort}` : ""].filter(Boolean).join(" · ") || " "));
  push(F(t.dim, "⎇ " + (d.branch ?? "no git") + "  ") + F(t.faint, tail(d.cwd, Math.max(6, inner - 4 - (d.branch?.length ?? 6)))));

  head("CONTEXT", d.ctxPct === null ? "" : F(pctColor(d.ctxPct, t), `${d.ctxPct}%`));
  const bw = inner, filled = Math.round(((d.ctxPct ?? 0) / 100) * bw);
  push(F(pctColor(d.ctxPct ?? 0, t), "▰".repeat(filled)) + F(t.border, "▱".repeat(Math.max(0, bw - filled))));
  push(F(t.dim, `${fmtTokens(d.ctxUsed)} / ${fmtTokens(d.ctxMax)} tokens`));
  if (d.series.length > 1) { const v = d.series.slice(-inner), mx = Math.max(1, ...v); push(F(t.accent2, v.map((x) => BARS[Math.min(7, Math.round((x / mx) * 7))]).join("")) + F(t.faint, "  per request")); }
  const mapRow = d.map.filter((m) => m.pct > 0).slice(0, 3).map((m) => F(m.color, "■") + F(t.dim, ` ${m.label} ${m.pct}%`)).join("  ");
  if (mapRow) for (const l of wrapPlain(mapRow, inner)) push(l);

  head("USAGE");
  push(F(t.dim, "in ") + F(t.text, fmtTokens(d.usage.prompt)) + F(t.dim, "  out ") + F(t.text, fmtTokens(d.usage.completion)) + F(t.dim, "  ") + F(t.faint, `${d.usage.calls} req`));
  if (d.usage.cached) push(F(t.dim, "cache ") + F(t.ok, `${Math.round((d.usage.cached / Math.max(1, d.usage.prompt)) * 100)}%`) + (d.usage.reasoning ? F(t.dim, "  reasoning ") + F(t.text, fmtTokens(d.usage.reasoning)) : ""));
  push(F(t.dim, "cost ") + (d.cost === null ? F(t.faint, "n/a") : BOLD(F(t.text, "≈ " + fmtCost(d.cost)))));

  if (d.todos.length) {
    const done = d.todos.filter((x) => x.status === "done").length;
    head("TODOS", F(t.dim, `${done}/${d.todos.length}`));
    for (const x of d.todos.slice(0, 7)) push((x.status === "done" ? F(t.ok, "✓ ") + F(t.faint, clipWidth(x.content, inner - 2)) : x.status === "in_progress" ? F(t.warn, "▶ ") + BOLD(F(t.text, clipWidth(x.content, inner - 2))) : F(t.faint, "○ ") + F(t.dim, clipWidth(x.content, inner - 2))));
    if (d.todos.length > 7) push(F(t.faint, `+${d.todos.length - 7} more`));
  }
  if (d.changes.length) {
    head("CHANGES", F(t.dim, String(d.changes.length)));
    for (const c of d.changes.slice(0, 8)) {
      const name = c.path.split("/").pop() ?? c.path, dir = c.path.includes("/") ? c.path.slice(0, c.path.length - name.length) : "", stat = F(t.addFg, `+${c.added}`) + " " + F(t.delFg, `−${c.removed}`);
      hits.push({ row: out.length, kind: "change", blockId: c.blockId });
      push(split(F(c.created ? t.ok : t.warn, c.created ? "A " : "M ") + F(t.text, clipWidth(name, inner - 14)) + F(t.faint, " " + clipWidth(dir, 8)), stat, inner, bg));
    }
    if (d.changes.length > 8) push(F(t.faint, `+${d.changes.length - 8} more files`));
  }
  head("WORKSPACE");
  push(F(t.dim, `${d.tools} tools`) + (d.mcp ? F(t.faint, ` · ${d.mcp} mcp`) : "") + (d.memory ? F(t.faint, ` · ${d.memory} notes`) : ""));
  if (d.tip) { push(); for (const l of wrap(d.tip, inner, 3)) push(F(t.faint, ITAL(l))); }

  const rows = out.slice(0, height).map((r) => parseAnsi(r));
  while (rows.length < height) rows.push(parseAnsi(fit("", width - 1, bg)));
  return { rows, hits };
}

const tail = (s: string, w: number) => (cellWidth(s) <= w ? s : "…" + s.slice(-(w - 1)));
const pctColor = (p: number, t: Theme) => (p > 85 ? t.err : p > 60 ? t.warn : t.ok);
function wrap(s: string, w: number, maxLines: number): string[] {
  const words = s.split(/\s+/), lines: string[] = [""];
  for (const word of words) { const last = lines[lines.length - 1]; if (cellWidth(last + " " + word) <= w) lines[lines.length - 1] = (last ? last + " " : "") + word; else lines.push(word); }
  const cut = lines.slice(0, maxLines); if (lines.length > maxLines) cut[maxLines - 1] = clipWidth(cut[maxLines - 1], w - 1) + "…";
  return cut.map((l) => clipWidth(l, w));
}
const wrapPlain = (s: string, w: number) => (cellWidth(s.replace(/\x1b\[[0-9;]*m/g, "")) <= w ? [s] : s.split("  ").reduce<string[]>((acc, part) => { const cur = acc[acc.length - 1]; if (cur !== undefined && cellWidth((cur + "  " + part).replace(/\x1b\[[0-9;]*m/g, "")) <= w) acc[acc.length - 1] = cur + "  " + part; else acc.push(part); return acc; }, []));
void A; void mix;

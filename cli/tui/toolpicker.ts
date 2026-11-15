// The tool picker: every tool the agent could use, in groups (built-in kinds, each MCP server, each plugin), each one on (listed in every
// request), on demand (found with tool_search when the model needs it: almost free) or off (never offered or run). Like the tools picker in
// VS Code's chat, with a third state and the token cost of each tool, so you can see and keep down what the tool list costs every request.
import type { ToolPicks } from "../../src/index.ts";
import { bold, cyan, dim, green, yellow } from "../ui.ts";
import type { Key } from "./keys.ts";
import type { Drawn, Overlay } from "./overlays.ts";
import { cellWidth, clipWidth } from "./text.ts";

export type PickState = "on" | "demand" | "off";
export type PickTool = { name: string; description: string; tokens: number; state: PickState; /** the state with no choice of yours */ def: PickState };
export type PickGroup = { id: string; label: string; kind: "builtin" | "mcp" | "plugin"; tools: PickTool[] };
export type PickResult = { states: Record<string, PickState>; scope?: "project" | "user" | "chat" };

/** Tools that are always there and cannot be chosen. */
export const FIXED = new Set(["finish", "tool_search", "call_tool"]);
const BUILTIN: [string, string[]][] = [
  ["Read and search", ["list_files", "read_file", "grep", "repo_map", "find_refs", "impact"]],
  ["Edit files", ["write_file", "edit_file", "apply_patch"]],
  ["Shell", ["sh", "sh_start", "sh_read", "sh_stop", "sh_list"]],
  ["Plan and delegate", ["todo_write", "task", "exit_plan_mode", "skill", "ask_user"]],
  ["Memory", ["memory_save", "memory_search", "memory_forget"]],
  ["Web", ["web_search", "fetch_url"]],
];
export const STATE_MARK: Record<PickState, string> = { on: "●", demand: "◐", off: "○" };
const NEXT: Record<PickState, PickState> = { on: "demand", demand: "off", off: "on" };
const paint = (s: PickState, t: string) => (s === "on" ? green(t) : s === "demand" ? yellow(t) : dim(t));
export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Group tools for the picker. `prefixOf` names the MCP server of a tool, `pluginOf` the plugin. */
export function groupTools(tools: Omit<PickTool, "def">[] & { def?: PickState }[], o: { mcp: (name: string) => string | undefined; plugin: (name: string) => string | undefined }): PickGroup[] {
  const left = new Map(tools.filter((t) => !FIXED.has(t.name)).map((t) => [t.name, t as PickTool]));
  const take = (n: string) => { const t = left.get(n); if (t) left.delete(n); return t; };
  const out: PickGroup[] = [];
  for (const [label, names] of BUILTIN) { const ts = names.map(take).filter((t): t is PickTool => !!t); if (ts.length) out.push({ id: `b:${label}`, label, kind: "builtin", tools: ts }); }
  const mcp = new Map<string, PickTool[]>(), plug = new Map<string, PickTool[]>(), other: PickTool[] = [];
  for (const t of left.values()) { const m = o.mcp(t.name), p = m ? undefined : o.plugin(t.name); if (m) mcp.set(m, [...(mcp.get(m) ?? []), t]); else if (p) plug.set(p, [...(plug.get(p) ?? []), t]); else other.push(t); }
  if (other.length) out.push({ id: "b:Other", label: "Other built-in", kind: "builtin", tools: other });
  for (const [k, ts] of mcp) out.push({ id: `m:${k}`, label: `MCP · ${k}`, kind: "mcp", tools: ts });
  for (const [k, ts] of plug) out.push({ id: `p:${k}`, label: `Plugin · ${k}`, kind: "plugin", tools: ts });
  return out;
}

/** The choices to save: only where a tool differs from its default; a whole MCP server in one state becomes one `<server>__*` entry. Choices for tools that are not here now (a server that is off) are kept. */
export function picksFrom(groups: PickGroup[], states: Record<string, PickState>, prev: ToolPicks = {}): ToolPicks {
  const here = new Set(groups.flatMap((g) => g.tools.map((t) => t.name))), out: Required<ToolPicks> = { on: [], demand: [], off: [] };
  const patterns = new Set(groups.filter((g) => g.kind === "mcp").map((g) => `${g.id.slice(2)}__*`));
  for (const v of ["on", "demand", "off"] as const) for (const e of prev[v] ?? []) if (e.endsWith("*") ? !patterns.has(e) : !here.has(e)) out[v].push(e);
  for (const g of groups) {
    const st = g.tools.map((t) => states[t.name] ?? t.state);
    if (g.kind === "mcp" && st.length && st.every((s) => s === st[0]) && g.tools.some((t) => t.def !== st[0])) { out[st[0]].push(`${g.id.slice(2)}__*`); continue; }
    g.tools.forEach((t, i) => { if (st[i] !== t.def) out[st[i]].push(t.name); });
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v.length)) as ToolPicks;
}

/** Counts and the token cost of what is listed in every request. */
export function totals(groups: PickGroup[], states: Record<string, PickState>) {
  const all = groups.flatMap((g) => g.tools), st = (t: PickTool) => states[t.name] ?? t.state;
  const on = all.filter((t) => st(t) === "on");
  return { on: on.length, demand: all.filter((t) => st(t) === "demand").length, off: all.filter((t) => st(t) === "off").length, tokens: on.reduce((n, t) => n + t.tokens, 0) };
}
const groupState = (g: PickGroup, states: Record<string, PickState>): PickState | "mixed" => { const s = new Set(g.tools.map((t) => states[t.name] ?? t.state)); return s.size === 1 ? [...s][0] : "mixed"; };

/** The terminal window: ↑↓ move, Space switches on → on demand → off, → ← open and close a group, type to filter, Enter saves, Esc leaves. */
export class ToolPickerOverlay implements Overlay {
  title = "Tools"; groups: PickGroup[]; states: Record<string, PickState> = {}; open = new Set<string>(); sel = 0; filter = ""; done: (r: PickResult | undefined) => void;
  constructor(groups: PickGroup[], done: (r: PickResult | undefined) => void) {
    this.groups = groups; this.done = done;
    for (const g of groups) if (g.kind === "builtin" && g.tools.length <= 8) this.open.add(g.id);
  }
  /** The rows on screen: groups, and the tools of open groups (all tools that match while filtering). */
  rows(): ({ g: PickGroup; t?: PickTool })[] {
    const q = this.filter.toLowerCase(), out: { g: PickGroup; t?: PickTool }[] = [];
    for (const g of this.groups) {
      const ts = q ? g.tools.filter((t) => `${t.name} ${t.description} ${g.label}`.toLowerCase().includes(q)) : g.tools;
      if (q && !ts.length) continue;
      out.push({ g }); if (q || this.open.has(g.id)) for (const t of ts) out.push({ g, t });
    }
    return out;
  }
  private set(r: { g: PickGroup; t?: PickTool }) {
    if (r.t) { this.states[r.t.name] = NEXT[this.states[r.t.name] ?? r.t.state]; return; }
    const cur = groupState(r.g, this.states), to = cur === "mixed" ? "on" : NEXT[cur];
    for (const t of r.g.tools) this.states[t.name] = to;
  }
  render(width: number, height = 18): Drawn {
    const rows = this.rows(), w = Math.max(40, width - 2), list: string[] = [];
    this.sel = Math.max(0, Math.min(this.sel, rows.length - 1));
    const top = Math.max(0, Math.min(this.sel - Math.floor(height / 2), rows.length - height));
    rows.slice(top, top + height).forEach((r, i) => {
      const cur = top + i === this.sel, pre = cur ? cyan("› ") : "  ";
      if (!r.t) {
        const gs = groupState(r.g, this.states), n = r.g.tools.filter((t) => (this.states[t.name] ?? t.state) === "on"), tok = n.reduce((a, t) => a + t.tokens, 0);
        const mark = gs === "mixed" ? "◑" : STATE_MARK[gs], left = `${this.filter || this.open.has(r.g.id) ? "▾" : "▸"} ${mark} ${r.g.label}`;
        const right = `${n.length}/${r.g.tools.length} on${tok ? ` · ${fmtTok(tok)} tok` : ""}`;
        list.push(pre + bold(gs === "mixed" ? left : paint(gs, left)) + " ".repeat(Math.max(1, w - 2 - cellWidth(left) - right.length)) + dim(right));
      } else {
        const s = this.states[r.t.name] ?? r.t.state, name = `    ${STATE_MARK[s]} ${r.t.name}`, tok = `${fmtTok(r.t.tokens)} tok`;
        const room = Math.max(0, w - 2 - cellWidth(name) - tok.length - 5), desc = room > 8 ? "  " + clipWidth(r.t.description.split(/(?<=\.)\s/)[0], room) : "";
        list.push(pre + paint(s, name) + dim(desc) + " ".repeat(Math.max(2, w - 2 - cellWidth(name) - cellWidth(desc) - tok.length)) + dim(tok));
      }
    });
    const t = totals(this.groups, this.states);
    return { lines: [
      dim(`  ${green("● on")}: listed in every request   ${yellow("◐ on demand")}: found with tool_search when needed   ○ off: never used`),
      "  " + (this.filter ? `filter: ${cyan(this.filter)}` : dim("type to filter")),
      "", ...(rows.length ? list : [dim("  no tool matches")]), "",
      `  ${bold(`${t.on} on`)} ${dim(`(≈ ${fmtTok(t.tokens)} tokens in every request)`)} · ${t.demand} on demand · ${t.off} off`,
      dim("  ↑↓ move · Space on / on demand / off · → ← open, close · Enter save · Esc leave"),
    ] };
  }
  key(k: Key) {
    const rows = this.rows(), r = rows[this.sel];
    if (k.name === "up") this.sel = Math.max(0, this.sel - 1);
    else if (k.name === "down") this.sel = Math.min(rows.length - 1, this.sel + 1);
    else if (k.name === "pageup") this.sel = Math.max(0, this.sel - 10);
    else if (k.name === "pagedown") this.sel = Math.min(rows.length - 1, this.sel + 10);
    else if (k.name === "home") this.sel = 0; else if (k.name === "end") this.sel = rows.length - 1;
    else if (k.name === "right" && r && !r.t) this.open.add(r.g.id);
    else if (k.name === "left" && r) { if (r.t) this.sel = rows.findIndex((x) => x.g === r.g && !x.t); else this.open.delete(r.g.id); }
    else if (k.name === "space" || (k.name === "char" && k.text === " ")) { if (r) this.set(r); }
    else if (k.name === "enter") this.done({ states: this.states });
    else if (k.name === "escape") { if (this.filter) { this.filter = ""; this.sel = 0; } else this.done(undefined); }
    else if (k.name === "backspace") { this.filter = this.filter.slice(0, -1); this.sel = 0; }
    else if (k.name === "char" && k.text && !k.ctrl && !k.alt) { this.filter += k.text; this.sel = 0; }
  }
}

// Autocomplete for the input box: "/commands" and "@file" mentions. Pure ranking + a lazily built file index.
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Suggestion = { label: string; insert: string; detail?: string; /** category header shown above the first item of each group (only when the list is not filtered) */ group?: string };
export type Token = { kind: "slash" | "file"; query: string; start: number; end: number };

/** What is the user completing right now? A slash command (first word of the input) or an @file mention. */
export function tokenAtCursor(text: string, cursor: number): Token | null {
  const before = text.slice(0, cursor);
  const slash = before.match(/^\/(\S*)$/);
  if (slash) return { kind: "slash", query: slash[1], start: 0, end: cursor };
  const file = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (file) return { kind: "file", query: file[1], start: cursor - file[1].length - 1, end: cursor };
  return null;
}

/** Categories of the built-in commands, in the order the menu shows them. A command that is not listed (yours, or a plugin's) goes under "Custom". */
export const GROUP_ORDER = ["Conversation", "Model & keys", "Safety", "Quality", "Project", "Extend", "Interface", "Custom"] as const;
const GROUP_MEMBERS: Record<string, string> = {};
for (const [g, names] of Object.entries({
  Conversation: "clear compact resume branch branches export import undo rewind copy todos exit",
  "Model & keys": "model provider connect effort api models router keepwarm budget tokens",
  Safety: "mode plan permissions policy sandbox approver hooks",
  Quality: "verify check review reviewer lsp report loop diff",
  Project: "init pr tools procs shell status live",
  Extend: "memory mcp skills agents plugins reload-plugins prompt strategy profile",
  Interface: "help theme sidebar details diffmode mouse ui",
})) for (const n of names.split(" ")) GROUP_MEMBERS[n] = g;
export const groupOf = (name: string): string => GROUP_MEMBERS[name] ?? "Custom";

/** All matching commands. With no query they come grouped by category (in GROUP_ORDER, A to Z inside a group); with a query, best match first. */
export function rankCommands(query: string, cmds: { name: string; help: string; alias?: string }[], limit = 500): Suggestion[] {
  const q = query.toLowerCase();
  const score = (c: { name: string; alias?: string }) => (c.name.startsWith(q) ? 3 : c.alias?.startsWith(q) ? 2 : c.name.includes(q) || c.alias?.includes(q) ? 1 : 0);
  const gi = (n: string) => GROUP_ORDER.indexOf(groupOf(n) as (typeof GROUP_ORDER)[number]);
  return cmds.map((c) => ({ c, score: score(c) }))
    .filter((x) => x.score > 0 || !q).sort((a, b) => (q ? b.score - a.score : gi(a.c.name) - gi(b.c.name)) || a.c.name.localeCompare(b.c.name)).slice(0, limit)
    .map(({ c }) => ({ group: q ? undefined : groupOf(c.name), label: "/" + c.name, insert: "/" + c.name + " ", detail: c.help + (c.alias && !c.name.includes(query.toLowerCase()) && c.alias.includes(query.toLowerCase()) ? ` (also /${c.alias})` : "") }));
}

/** Subsequence fuzzy match. Tries the greedy alignment and the exact-substring alignments and keeps the best. null = no match. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase(), p = path.toLowerCase(), base = p.lastIndexOf("/") + 1;
  if (!q) return -path.length;
  const score = (pos: number[]) => {
    let s = 0, run = 0, prev = -2;
    for (const i of pos) {
      run = prev === i - 1 ? run + 1 : 1;
      s += 1 + run * 2 + (i === 0 || "/._-".includes(p[i - 1]) ? 6 : 0) + (i >= base ? 4 : 0);
      prev = i;
    }
    return s;
  };
  const greedy: number[] = [];
  for (let i = 0, qi = 0; i < p.length && qi < q.length; i++) if (p[i] === q[qi]) { greedy.push(i); qi++; }
  if (greedy.length < q.length) return null;
  const run = (at: number) => Array.from({ length: q.length }, (_, k) => at + k);
  const inBase = p.indexOf(q, base), anywhere = p.indexOf(q);
  let best = score(greedy);
  if (anywhere >= 0) best = Math.max(best, score(run(anywhere)) + 15);
  if (inBase >= 0) best = Math.max(best, score(run(inBase)) + 15 + (inBase === base ? 25 : 0));
  return best - path.length * 0.05;
}

export function rankFiles(query: string, files: string[], limit = 8): Suggestion[] {
  return files.map((f) => ({ f, s: fuzzyScore(query, f) })).filter((x): x is { f: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f)).slice(0, limit)
    .map(({ f }) => ({ label: f, insert: "@" + f + " ", detail: undefined }));
}

export function applySuggestion(text: string, t: Token, s: Suggestion): { text: string; cursor: number } {
  const next = text.slice(0, t.start) + s.insert + text.slice(t.end);
  return { text: next, cursor: t.start + s.insert.length };
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "target", ".amness", ".cache", "coverage"]);

/** Project file list: `git ls-files` when available (respects .gitignore), else a bounded directory walk. Refreshes at most every few seconds. */
export class FileIndex {
  files: string[] = [];
  private at = 0;
  private loading: Promise<void> | null = null;
  cwd: string; maxFiles: number;
  constructor(cwd: string, maxFiles = 8000) { this.cwd = cwd; this.maxFiles = maxFiles; }

  /** Has the list been (re)built recently enough to trust? */
  fresh(maxAgeMs = 5000) { return Date.now() - this.at < maxAgeMs; }
  ensure(maxAgeMs = 5000): Promise<void> {
    if (Date.now() - this.at < maxAgeMs) return Promise.resolve();
    return (this.loading ??= this.load().finally(() => { this.loading = null; }));
  }
  private load(): Promise<void> {
    return new Promise((done) => {
      execFile("git", ["ls-files", "-co", "--exclude-standard"], { cwd: this.cwd, maxBuffer: 32 << 20 }, (err, out) => {
        this.files = !err && out.trim() ? out.split("\n").filter(Boolean).slice(0, this.maxFiles) : this.walk();
        this.at = Date.now(); done();
      });
    });
  }
  private walk(): string[] {
    const out: string[] = [];
    const rec = (dir: string, rel: string) => {
      let names: string[] = [];
      try { names = readdirSync(dir).sort(); } catch { return; }
      for (const n of names) {
        if (out.length >= this.maxFiles) return;
        if (SKIP.has(n) || (n.startsWith(".") && n !== ".github")) continue;
        const p = join(dir, n), r = rel ? rel + "/" + n : n;
        try { statSync(p).isDirectory() ? rec(p, r) : out.push(r); } catch { /* unreadable */ }
      }
    };
    rec(this.cwd, "");
    return out;
  }
}

export type MenuRow = { head: string } | { item: number };
/** The rows to draw for a suggestion list: a window of `win` rows that keeps the selected item in view, with a header row above each new group (headers cannot be selected). */
export function menuRows(items: Suggestion[], sel: number, win: number): { rows: MenuRow[]; above: number; below: number } {
  const all: MenuRow[] = []; let selRow = 0, last: string | undefined;
  items.forEach((it, i) => { if (it.group && it.group !== last) all.push({ head: it.group }); last = it.group; if (i === sel) selRow = all.length; all.push({ item: i }); });
  win = Math.max(1, win);
  let top = Math.max(0, Math.min(selRow - Math.floor(win / 2), all.length - win));
  if (selRow - 1 >= 0 && "head" in all[selRow - 1] && top > selRow - 1) top = selRow - 1; // keep the group title with its first command
  const rows = all.slice(top, top + win);
  const count = (r: MenuRow[]) => r.filter((x) => "item" in x).length;
  return { rows, above: count(all.slice(0, top)), below: count(all.slice(top + win)) };
}

// Autocomplete for the input box: "/commands" and "@file" mentions. Pure ranking + a lazily built file index.
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Suggestion = { label: string; insert: string; detail?: string };
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

export function rankCommands(query: string, cmds: { name: string; help: string; alias?: string }[], limit = 8): Suggestion[] {
  const q = query.toLowerCase();
  const score = (c: { name: string; alias?: string }) => (c.name.startsWith(q) ? 3 : c.alias?.startsWith(q) ? 2 : c.name.includes(q) || c.alias?.includes(q) ? 1 : 0);
  return cmds.map((c) => ({ c, score: score(c) }))
    .filter((x) => x.score > 0 || !q).sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name)).slice(0, limit)
    .map(({ c }) => ({ label: "/" + c.name, insert: "/" + c.name + " ", detail: c.help + (c.alias && !c.name.includes(query.toLowerCase()) && c.alias.includes(query.toLowerCase()) ? ` (also /${c.alias})` : "") }));
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

// A structural index of the repository, built from plain files with no dependencies: symbols (functions, classes, types...), the import graph between files, and
// where each symbol is used. It answers "where does this live and what depends on it" in one call instead of a dozen greps (the idea behind Aider's repo map and
// the structural indexes in recent coding-agent work), and it is rebuilt incrementally from file modification times.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { defineTool, type Tool } from "./harness.ts";

export type Sym = { name: string; kind: string; line: number; sig: string };
export type FileInfo = { path: string; lang: string; lines: number; mtime: number; size: number; symbols: Sym[]; imports: string[]; ids: Map<string, number> };

const IGNORE = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".amness", "__pycache__", ".venv", "venv", ".next", ".cache", "coverage", "vendor", ".gradle", ".idea", ".vscode"]);
const LANG: Record<string, string> = { ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".py": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "kt", ".cs": "cs", ".rb": "rb", ".php": "php", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".swift": "swift", ".scala": "scala" };
const STOP = new Set("if else for while return new this self true false null undefined none nil let const var def func fn function class struct enum type interface public private protected static final async await import from export default package use mod pub void int string bool boolean float double char long short byte then end do case switch break continue try catch finally throw throws raise with as in is not and or the".split(" "));

type Rule = [RegExp, string];
const RULES: Record<string, Rule[]> = {
  ts: [[/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, "function"], [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, "class"], [/^\s*(?:export\s+)?interface\s+(\w+)/, "interface"], [/^\s*(?:export\s+)?type\s+(\w+)\s*[=<]/, "type"], [/^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/, "enum"],
    [/^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/, "function"], [/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/, "method"]],
  py: [[/^\s*(?:async\s+)?def\s+(\w+)/, "function"], [/^\s*class\s+(\w+)/, "class"]],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/, "func"], [/^type\s+(\w+)\s+(?:struct|interface)/, "type"]],
  rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, "fn"], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/, "type"], [/^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/, "impl"]],
  java: [[/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s+(\w+)/, "class"], [/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+)+[\w<>\[\],.? ]+\s+(\w+)\s*\([^)]*\)\s*(?:throws [\w, .]+)?\s*\{/, "method"]],
  rb: [[/^\s*def\s+(?:self\.)?(\w+[?!]?)/, "def"], [/^\s*(?:class|module)\s+(\w+)/, "class"]],
  php: [[/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)/, "function"], [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/, "class"]],
  c: [[/^[A-Za-z_][\w \t\*]+?\b(\w+)\s*\([^;{]*\)\s*\{/, "function"], [/^\s*(?:typedef\s+)?(?:struct|enum|union)\s+(\w+)/, "type"]],
};
RULES.js = RULES.ts; RULES.kt = [[/^\s*(?:private\s+|public\s+|internal\s+|override\s+|suspend\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/, "fun"], [/^\s*(?:data\s+|sealed\s+|abstract\s+|open\s+)*(?:class|interface|object)\s+(\w+)/, "class"]];
RULES.cs = RULES.java; RULES.cpp = RULES.c; RULES.swift = [[/^\s*(?:public\s+|private\s+|internal\s+|static\s+|override\s+)*func\s+(\w+)/, "func"], [/^\s*(?:public\s+|final\s+)*(?:class|struct|enum|protocol)\s+(\w+)/, "type"]]; RULES.scala = [[/^\s*def\s+(\w+)/, "def"], [/^\s*(?:case\s+)?(?:class|object|trait)\s+(\w+)/, "class"]];

const IMPORTS: Record<string, RegExp[]> = {
  ts: [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm, /\bexport\s+[^'"\n]*\bfrom\s+["']([^"']+)["']/g],
  py: [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*(?:import\s+)?(?:\w+\s+)?"([\w./-]+)"\s*$/gm], rs: [/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm], java: [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
  rb: [/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm], php: [/^\s*(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/gm], c: [/^\s*#\s*include\s+"([^"]+)"/gm],
};
IMPORTS.js = IMPORTS.ts; IMPORTS.kt = IMPORTS.java; IMPORTS.cs = [/^\s*using\s+([\w.]+)\s*;/gm]; IMPORTS.cpp = IMPORTS.c; IMPORTS.swift = [/^\s*import\s+(\w+)/gm]; IMPORTS.scala = IMPORTS.java;

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

export function indexFile(path: string, text: string, mtime = 0): FileInfo {
  const lang = LANG[extname(path).toLowerCase()] ?? "", lines = text.split("\n"), symbols: Sym[] = [], rules = RULES[lang] ?? [];
  const seenSym = new Set<string>();
  lines.forEach((l, i) => {
    if (l.length > 300 || /^\s*(\/\/|#|\*|\/\*)/.test(l) && lang !== "py" && lang !== "rb" && !/^\s*(#\s*include)/.test(l)) return;
    if ((lang === "py" || lang === "rb") && /^\s*#/.test(l)) return;
    for (const [re, kind] of rules) { const m = re.exec(l); if (m && m[1] && !STOP.has(m[1]) && !seenSym.has(m[1] + ":" + kind)) { seenSym.add(m[1] + ":" + kind); symbols.push({ name: m[1], kind, line: i + 1, sig: l.trim().replace(/\s*[{:]\s*$/, "").slice(0, 110) }); break; } }
  });
  const imports: string[] = []; for (const re of IMPORTS[lang] ?? []) for (const m of text.matchAll(new RegExp(re.source, re.flags))) imports.push(m[1]);
  const ids = new Map<string, number>(); for (const m of text.matchAll(/[A-Za-z_]\w{2,}/g)) { const w = m[0]; if (!STOP.has(w)) ids.set(w, (ids.get(w) ?? 0) + 1); }
  return { path, lang, lines: lines.length, mtime, size: text.length, symbols, imports: [...new Set(imports)], ids };
}

export class CodeIndex {
  files = new Map<string, FileInfo>(); private root: string; private built = 0; private edges = new Map<string, Set<string>>(); private rev = new Map<string, Set<string>>(); private symDefs = new Map<string, { file: string; sym: Sym }[]>(); private cap: number;
  constructor(root: string, o: { maxFiles?: number } = {}) { this.root = resolve(root); this.cap = o.maxFiles ?? 5000; }

  /** Source files currently under the root (fast: names and sizes only). */
  list(): string[] {
    const out: string[] = [], walk = (d: string, depth: number) => {
      let es: string[] = []; try { es = readdirSync(d).sort(); } catch { return; }
      for (const e of es) { if (out.length >= this.cap) return; if (IGNORE.has(e) || e.startsWith(".") && e !== ".github") continue; const p = join(d, e); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) { if (depth < 12) walk(p, depth + 1); } else if (LANG[extname(e).toLowerCase()] && st.size <= 400_000) out.push(relative(this.root, p).split(sep).join("/")); }
    };
    walk(this.root, 0); return out;
  }

  /** Bring the index up to date: re-read only files whose modification time or size changed. */
  refresh(): { files: number; changed: number } {
    const now = this.list(), live = new Set(now); let changed = 0;
    for (const p of [...this.files.keys()]) if (!live.has(p)) { this.files.delete(p); changed++; }
    for (const p of now) {
      let st; try { st = statSync(join(this.root, p)); } catch { continue; }
      const old = this.files.get(p); if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
      try { this.files.set(p, indexFile(p, readFileSync(join(this.root, p), "utf8"), st.mtimeMs)); changed++; } catch { /* unreadable */ }
    }
    if (changed || !this.built) this.link(); this.built = Date.now();
    return { files: this.files.size, changed };
  }

  private resolveImport(from: FileInfo, spec: string): string | undefined {
    const known = (p: string) => (this.files.has(p) ? p : undefined), dir = dirname(from.path);
    const tryPaths = (base: string) => known(base) ?? [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".rb", ".php", ".h", ".c", ".go", ".rs"].map((e) => known(base + e)).find(Boolean) ?? [".ts", ".js", ".py"].map((e) => known(join(base, "index" + e).split(sep).join("/")) ?? known(join(base, "__init__" + e).split(sep).join("/"))).find(Boolean);
    const norm = (p: string) => p.split(sep).join("/").replace(/^\.\//, "");
    if (from.lang === "ts" || from.lang === "js" || from.lang === "rb" || from.lang === "php" || from.lang === "c" || from.lang === "cpp") {
      if (!spec.startsWith(".") && from.lang !== "c" && from.lang !== "cpp") return undefined;               // a package, not one of our files
      const base = norm(join(dir, spec)); return tryPaths(base) ?? tryPaths(base.replace(/\.(m|c)?js$/, "")) ;   // "./x.js" in TypeScript means x.ts
    }
    if (from.lang === "py") {
      if (spec.startsWith(".")) { const dots = /^\.+/.exec(spec)![0].length; let d = dir; for (let i = 1; i < dots; i++) d = dirname(d); return tryPaths(norm(join(d, spec.slice(dots).replace(/\./g, "/")))); }
      const rel = norm(spec.replace(/\./g, "/"));
      const direct = tryPaths(rel) ?? tryPaths(norm(join(dir, rel))); if (direct) return direct;
      const hits = [...this.files.keys()].filter((p) => p.endsWith("/" + rel + ".py") || p.endsWith("/" + rel + "/__init__.py"));   // the package root is a subfolder (src/, py/...): match by path suffix when unique
      return hits.length === 1 ? hits[0] : undefined;
    }
    if (from.lang === "go" || from.lang === "java" || from.lang === "kt" || from.lang === "scala" || from.lang === "cs" || from.lang === "rs") {
      const last = spec.split(/[./:]+/).filter(Boolean).pop(); if (!last) return undefined;
      const hits = [...this.files.keys()].filter((p) => p !== from.path && (p.endsWith("/" + last + extname(p)) || p === last + extname(p))); return hits.length === 1 ? hits[0] : undefined;
    }
    return undefined;
  }
  private link() {
    this.edges.clear(); this.rev.clear(); this.symDefs.clear();
    for (const f of this.files.values()) {
      for (const s of f.symbols) { const l = this.symDefs.get(s.name) ?? []; l.push({ file: f.path, sym: s }); this.symDefs.set(s.name, l); }
      const out = new Set<string>(); for (const spec of f.imports) { const t = this.resolveImport(f, spec); if (t && t !== f.path) out.add(t); } this.edges.set(f.path, out);
      for (const t of out) { const r = this.rev.get(t) ?? new Set(); r.add(f.path); this.rev.set(t, r); }
    }
  }

  importedBy(path: string) { return [...(this.rev.get(path) ?? [])].sort(); }
  imports(path: string) { return [...(this.edges.get(path) ?? [])].sort(); }
  /** Files that depend on `path`, directly or through up to `depth` hops. */
  dependents(path: string, depth = 2): { file: string; hops: number }[] {
    const seen = new Map<string, number>([[path, 0]]); let frontier = [path];
    for (let h = 1; h <= depth; h++) { const next: string[] = []; for (const p of frontier) for (const d of this.rev.get(p) ?? []) if (!seen.has(d)) { seen.set(d, h); next.push(d); } frontier = next; }
    seen.delete(path); return [...seen].map(([file, hops]) => ({ file, hops })).sort((a, b) => a.hops - b.hops || (a.file < b.file ? -1 : 1));
  }
  definitions(name: string) { return this.symDefs.get(name) ?? []; }
  /** Files that mention `name` as an identifier (excluding the ones that define it), with counts. */
  users(name: string): { file: string; count: number }[] { const defs = new Set(this.definitions(name).map((d) => d.file)); return [...this.files.values()].filter((f) => f.ids.has(name) && !defs.has(f.path)).map((f) => ({ file: f.path, count: f.ids.get(name)! })).sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : 1)); }

  /** Rank files for `query` (identifier overlap with paths and symbols, weighted up for definitions) with a small boost for files many others import. Without a query: the most central files. */
  rank(query?: string, limit = 12): { file: FileInfo; score: number; why: string[] }[] {
    const q = [...new Set(words(query ?? ""))], maxIn = Math.max(1, ...[...this.rev.values()].map((s) => s.size));
    const rows = [...this.files.values()].map((f) => {
      const pw = new Set(words(f.path)), why: string[] = []; let score = 0;
      for (const w of q) {
        if (pw.has(w)) { score += 3; why.push(`path:${w}`); }
        for (const s of f.symbols) if (words(s.name).includes(w)) { score += s.kind === "class" || s.kind === "type" || s.kind === "interface" ? 4 : 3; if (why.length < 4) why.push(`${s.kind} ${s.name}`); }
        const direct = f.ids.get(w) ?? [...f.ids.keys()].filter((k) => words(k).includes(w)).reduce((n, k) => n + Math.min(3, f.ids.get(k)!), 0); if (direct) score += Math.min(2, Math.log2(1 + direct) * 0.5);
      }
      const central = (this.rev.get(f.path)?.size ?? 0) / maxIn;
      if (q.length && score === 0) return { file: f, score: 0, why };                                 // a file that matches no query word is not an answer, however central it is
      return { file: f, score: (q.length ? score : 0) + central * (q.length ? 1.2 : 5) + Math.min(f.symbols.length, 20) * (q.length ? 0 : 0.05), why };
    });
    return rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1)).slice(0, limit);
  }

  /** A compact map: ranked files with their main symbols, within a character budget. */
  map(query?: string, maxChars = 3500, limit = 14): string {
    const out: string[] = []; let used = 0;
    for (const r of this.rank(query, limit)) {
      const syms = r.file.symbols.filter((s) => s.kind !== "method" || query).slice(0, 8).map((s) => `  ${s.kind} ${s.name} :${s.line}`), head = `${r.file.path} (${r.file.lines} lines${this.rev.get(r.file.path)?.size ? `, imported by ${this.rev.get(r.file.path)!.size}` : ""})`;
      const block = [head, ...syms].join("\n"); if (used + block.length > maxChars && out.length) { out.push(`… more files match; narrow the query`); break; } out.push(block); used += block.length + 1;
    }
    return out.join("\n") || "(nothing indexed matches; try another word, or use grep)";
  }
}

/** Tools: `repo_map`, `find_refs`, `impact`. Read-only. */
export function indexTools(index: CodeIndex): Tool[] {
  const ready = () => { index.refresh(); };
  return [
    defineTool<{ query?: string; max_chars?: number }>({ name: "repo_map", readOnly: true,
      description: "Where things live in this repository: the most relevant files for a query (words from a feature, symbol or concept), each with its main functions, classes and types and how many files import it. Use it first in an unfamiliar or large repository, before grep.",
      schema: { type: "object", properties: { query: { type: "string", description: "what you are looking for, e.g. 'invoice tax calculation'; omit for the overall structure" }, max_chars: { type: "integer" } } },
      run: ({ query, max_chars }) => { ready(); return index.map(query, Math.min(8000, Math.max(500, max_chars ?? 3500))); } }),
    defineTool<{ symbol: string }>({ name: "find_refs", readOnly: true,
      description: "Where a function, class or type is defined, and which files use it (by identifier, with counts). Faster than grep for 'who calls this'.",
      schema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } },
      run: ({ symbol }) => {
        ready(); const defs = index.definitions(symbol), users = index.users(symbol);
        if (!defs.length && !users.length) return `no definition or use of "${symbol}" found in the index (it indexes functions, classes and types in ${[...new Set([...index.files.values()].map((f) => f.lang))].join(", ")}; try grep for other text)`;
        return [`definitions:`, ...(defs.length ? defs.slice(0, 10).map((d) => `  ${d.file}:${d.sym.line}  ${d.sym.sig}`) : ["  (none found; it may come from a dependency)"]), `used in ${users.length} file(s):`, ...users.slice(0, 25).map((u) => `  ${u.file}  (${u.count}×)`), ...(users.length > 25 ? [`  … and ${users.length - 25} more`] : [])].join("\n");
      } }),
    defineTool<{ path: string }>({ name: "impact", readOnly: true,
      description: "What depends on a file: who imports it (directly and one step further) and which of its symbols are used elsewhere. Use before changing a shared file's behaviour or signature.",
      schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      run: ({ path }) => {
        ready(); const p = path.replace(/^\.\//, ""), f = index.files.get(p); if (!f) return `${p} is not in the index (indexed: ${[...index.files.keys()].slice(0, 5).join(", ")}…)`;
        const deps = index.dependents(p, 2), used = f.symbols.map((s) => ({ s, u: index.users(s.name).filter((x) => x.file !== p) })).filter((x) => x.u.length);
        return [`${p}: imports ${index.imports(p).length} file(s); ${index.importedBy(p).length} import it directly, ${deps.filter((d) => d.hops === 2).length} more through them.`,
          ...(deps.length ? ["dependents:", ...deps.slice(0, 20).map((d) => `  ${d.file}${d.hops > 1 ? "  (via another import)" : ""}`)] : ["nothing in the index imports this file"]),
          ...(used.length ? ["symbols used elsewhere:", ...used.slice(0, 12).map(({ s, u }) => `  ${s.kind} ${s.name} → ${u.slice(0, 4).map((x) => x.file).join(", ")}${u.length > 4 ? ` +${u.length - 4}` : ""}`)] : [])].join("\n");
      } }),
  ];
}

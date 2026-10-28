// Failure mining: read the session traces, group what went wrong into recurring patterns, and turn a chosen failure into an eval task so it can never silently come back.
import { slash } from "./shell.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { TraceLine } from "./trace.ts";

export type Failure = { file: string; session: string; turn: number; category: string; signature: string; detail: string; task: string };
export type Cluster = { category: string; signature: string; count: number; sessions: number; examples: Failure[] };
export type TraceSummary = { file: string; session: string; task: string; turns: number; tokens: number; cached: number; prompt: number; tools: number; finished: boolean; failures: number };

const CAT: Record<string, string> = { loop: "stuck in a loop", nudge: "needed a nudge", repair: "malformed tool call", rejected: "finish rejected", denied: "action denied", hook: "hook intervened", budget: "ran out of budget", aborted: "interrupted by the user" };
/** Make two instances of the same problem look the same: numbers, hex ids, paths and quoted names are replaced. */
const shape = (s: string) => s.replace(/\s+/g, " ").replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/gi, "#").replace(/\b\d+(\.\d+)?\b/g, "N").replace(/(["'`])[^"'`]{1,60}\1/g, "$1…$1").replace(/(?:\/[\w.@-]+){2,}/g, "<path>").trim().slice(0, 90);

function parse(file: string): TraceLine[] { const out: TraceLine[] = []; try { for (const l of readFileSync(file, "utf8").split("\n")) if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* partial last line */ } } } catch { /* unreadable */ } return out; }
const sessionOf = (file: string) => file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, "");
const lastUser = (m: unknown) => { const arr = (Array.isArray(m) ? m : []) as { role?: string; content?: string }[]; const u = [...arr].reverse().find((x) => x.role === "user"); return (u?.content ?? "").split("\n\n## ")[0].split("\n\n[hook")[0].slice(0, 300); };

export function readFailures(dir: string): { failures: Failure[]; traces: TraceSummary[] } {
  const failures: Failure[] = [], traces: TraceSummary[] = [];
  if (!existsSync(dir)) return { failures, traces };
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const file = join(dir, name), lines = parse(file), session = sessionOf(file); let turn = 0, task = "", tokens = 0, cached = 0, prompt = 0, tools = 0, finished = false, n = 0;
    for (const l of lines) {
      if (l.kind === "run") task = lastUser(l.messages) || task;
      else if (l.kind === "turn") { turn++; tokens += Number(l.prompt ?? 0) + Number(l.completion ?? 0); prompt += Number(l.prompt ?? 0); cached += Number(l.cached ?? 0); }
      else if (l.kind === "toolstart") tools++;
      else if (l.kind === "finish") finished = true;
      else if (CAT[l.kind] || (l.kind === "tool" && l.ok === false && /^(ERROR|BLOCKED)/.test(String(l.result)))) {
        const category = CAT[l.kind] ?? "tool error", detail = String(l.detail ?? l.reason ?? l.result ?? "").slice(0, 300);
        if (l.kind === "aborted") continue;                    // an interrupt is a signal, not a defect
        failures.push({ file, session, turn, category, signature: `${category}: ${shape(detail)}`, detail, task }); n++;
      }
    }
    traces.push({ file, session, task, turns: turn, tokens, cached, prompt, tools, finished, failures: n });
  }
  return { failures, traces };
}

export function clusterFailures(failures: Failure[]): Cluster[] {
  const by = new Map<string, Failure[]>(); for (const f of failures) { const l = by.get(f.signature) ?? []; l.push(f); by.set(f.signature, l); }
  return [...by].map(([signature, list]) => ({ category: list[0].category, signature, count: list.length, sessions: new Set(list.map((f) => f.session)).size, examples: list.slice(0, 3) })).sort((a, b) => b.count - a.count || b.sessions - a.sessions);
}

export function formatMining(dir: string, o: { top?: number } = {}): string {
  const { failures, traces } = readFailures(dir), clusters = clusterFailures(failures), out: string[] = [];
  if (!traces.length) return `no traces in ${dir} yet. Traces are written for every chat session (and for headless runs with --trace).`;
  const done = traces.filter((t) => t.finished).length, tok = traces.reduce((n, t) => n + t.tokens, 0), prompt = traces.reduce((n, t) => n + t.prompt, 0), cached = traces.reduce((n, t) => n + t.cached, 0);
  out.push(`${traces.length} session(s), ${done} finished a task, ${failures.length} failure signal(s) in ${clusters.length} pattern(s); ${tok.toLocaleString()} tokens${prompt ? `, ${Math.round((cached / prompt) * 100)}% of prompts served from cache` : ""}`, "");
  if (!clusters.length) out.push("no recurring problems found.");
  for (const c of clusters.slice(0, o.top ?? 8)) {
    out.push(`${String(c.count).padStart(3)}×  ${c.signature}  (${c.sessions} session${c.sessions === 1 ? "" : "s"})`);
    for (const e of c.examples.slice(0, 2)) out.push(`       e.g. ${e.session} turn ${e.turn}${e.task ? `: "${e.task.slice(0, 70).replace(/\s+/g, " ")}"` : ""}`);
  }
  const worst = [...traces].filter((t) => t.failures).sort((a, b) => b.failures - a.failures).slice(0, 3);
  if (worst.length) out.push("", "sessions with the most trouble:", ...worst.map((t) => `  ${t.session}: ${t.failures} signal(s), ${t.turns} turns${t.finished ? "" : ", did not finish"}${t.task ? ` — "${t.task.slice(0, 60).replace(/\s+/g, " ")}"` : ""}`));
  out.push("", "to keep a failure from coming back: amness traces --case <name> --task \"...\" --check \"<command that exits 0 when fixed>\"  (snapshots the repo at HEAD into an eval task)");
  return out.join("\n");
}

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".css", ".html", ".yml", ".yaml", ".toml", ".sh", ".sql", ".kt", ".swift", ".cs", ".gradle", ".xml", ".lock", ""]);
/** Snapshot a repository (tracked files at HEAD, or the working tree outside git) as an eval case file. The check is yours: it decides whether the task is solved. */
export function caseFromWorkspace(cwd: string, o: { name: string; task: string; check: string; verify?: string; dir?: string; maxBytes?: number }): { path: string; files: number; bytes: number } {
  const files: Record<string, string> = {}; let bytes = 0; const cap = o.maxBytes ?? 1_000_000;
  const add = (p: string, text: string) => { if (bytes + text.length > cap || text.length > 150_000 || text.includes("\u0000")) return; files[p] = text; bytes += text.length; };
  let tracked: string[] | undefined; try { tracked = execFileSync("git", ["ls-files", "-z"], { cwd, maxBuffer: 32 << 20 }).toString().split("\0").filter(Boolean); } catch { tracked = undefined; }
  if (tracked) for (const p of tracked) { if (!TEXT_EXT.has(extname(p).toLowerCase()) || /package-lock|yarn\.lock|pnpm-lock/.test(p)) continue; try { add(p, execFileSync("git", ["show", `HEAD:${p}`], { cwd, maxBuffer: 8 << 20 }).toString()); } catch { /* not committed yet */ } }
  else { const walk = (d: string) => { for (const e of readdirSync(d).sort()) { if (["node_modules", ".git", ".amness", "dist", "build"].includes(e)) continue; const p = join(d, e), st = statSync(p); if (st.isDirectory()) walk(p); else if (TEXT_EXT.has(extname(e).toLowerCase())) { try { add(slash(relative(cwd, p)), readFileSync(p, "utf8")); } catch { /* skip */ } } } }; walk(cwd); }
  const dir = o.dir ?? join(cwd, ".amness", "evals", "cases"); mkdirSync(dir, { recursive: true });
  const name = o.name.replace(/[^\w.-]+/g, "-").slice(0, 60), path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ name, task: o.task, verify: o.verify, check: o.check, files }, null, 1));
  return { path, files: Object.keys(files).length, bytes };
}

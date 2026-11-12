// Is the run actually getting anywhere? Judged from objective signals (failing-test counts, new files edited, new code written), never from what the model says.
// A loop that keeps acting without any of them improving is stagnating, however confident its messages sound.
import { BUILD_CMD, TEST_CMD } from "./ledger.ts";

/** A comparison of outputs (diff, cmp): on a task with no test suite, comparing against a reference program's output is the check. Without it, a run that wrote the program and was comparing outputs until they matched was stopped as making "no measurable progress". */
const COMPARE_CMD = /(?:^|[\s;&|(])(?:diff|cmp)\s/;
/** 1 when the outputs differ (diff lines, "differ", a failing exit), else 0. The exit code alone is not enough: a compound command usually ends with an echo. */
const compared = (out: string) => (/^[<>] |^@@ |\bdiffer(?:s|ent)?\b|^exit=[1-9]/im.test(out) ? 1 : 0);
/** Number of failures in a test/build/lint output, or undefined when it does not look like one. A failing exit code with no readable count counts as 1. */
export function countFailures(cmd: string, result: string): number | undefined {
  if (!TEST_CMD.test(cmd) && !BUILD_CMD.test(cmd)) return COMPARE_CMD.test(cmd) && !/\bgit\s+diff\b/.test(cmd) ? compared(result) : undefined;
  const exit = /^exit=(\d+)/.exec(result)?.[1], out = result;
  const num = (re: RegExp) => { const m = re.exec(out); return m ? Number(m[1]) : undefined; };
  const counts = [num(/(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/i), num(/\bfail(?:ed|ures?|ing)?:\s*(\d+)/i), num(/Tests:\s+(\d+)\s+failed/i), num(/#\s*fail\s+(\d+)/i), num(/ℹ\s*fail\s+(\d+)/i), num(/failures=(\d+)/i)].filter((x): x is number => x !== undefined);
  const ts = (out.match(/\berror TS\d+/g) ?? []).length, lint = num(/(\d+)\s+problems?\b/i), errs = num(/\b(\d+)\s+errors?\b/i);
  const total = (counts.length ? Math.max(...counts) : 0) + ts + (lint ?? 0) + (counts.length || ts || lint ? 0 : errs ?? 0);
  if (total > 0) return total;
  return exit && exit !== "0" ? 1 : 0;
}

// Reading through the shell. Not a permission check (READONLY_CMD in src/code.ts is that one, and much stricter): it only tells "this turn looked at things" from "this turn did something",
// so a model that inspects with xxd, od or cat | head is seen as reading, like one that uses read_file.
const INSPECT = /^(?:ls|cat|head|tail|wc|grep|egrep|fgrep|rg|od|xxd|hexdump|strings|file|stat|which|type|tree|less|more|nl|cut|sort|uniq|tr|column|jq|du|df|pwd|echo|printf|find(?!.*\s-(?:exec|execdir|delete|ok|fprint))|sed\s+-n(?!.*\s-i)|git\s+(?:status|log|show|ls-files|blame))(?:\s|$)/;
/** True when every part of a shell command only looks at things: each pipeline step is an inspection command, there is no output redirection to a file, and a leading `cd dir &&` is allowed. */
export function isInspection(cmd: string): boolean {
  if (/\$\(|`/.test(cmd) || /(?:^|[^2&])>(?!\s*\/dev\/null|&)/.test(cmd.replace(/2>&1/g, ""))) return false;   // command substitution can run anything
  const parts = cmd.split(/\|\|?|&&|;|\n/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((x, i) => INSPECT.test(x) || (i < parts.length - 1 && /^cd\s+\S+$/.test(x)));
}
const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
/** The file and folder names a shell command reads: words with a slash or a file extension, flags and numbers left out. */
export function inspectedPaths(cmd: string): string[] {
  return [...new Set(cmd.split(/[\s|;&]+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter((w) => w && !w.startsWith("-") && !/^\d+$/.test(w) && !/:\/\//.test(w) && (/\//.test(w) || /^[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(w))).map(norm))];
}

/** The inverse of a unified diff hunk set (swap + and -), as a comparable string. */
const invert = (diff: string) => diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).map((l) => (l[0] === "+" ? "-" : "+") + l.slice(1)).sort().join("\n");
const body = (diff: string) => diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).sort().join("\n");

export type TurnFacts = { calls: { name: string; args: any; result: string }[]; edits: { path: string; diff: string }[] };

export class ProgressTracker {
  private bestFail = Infinity; private everFailed = new Set<string>(); private editedPaths = new Set<string>(); private seenDiffs = new Map<string, Set<string>>(); private reads = new Set<string>(); private changedSinceCheck = false;
  /** Turns in a row without an objective improvement. */
  stale = 0; lastFailures: number | undefined; reasons: string[] = [];
  private readCap: number;
  constructor(readCap = 15) { this.readCap = readCap; }

  /** Feed one turn; returns why it counted as progress (empty = it did not). */
  observe(t: TurnFacts): string[] {
    const why: string[] = [];
    for (const e of t.edits) {
      const seen = this.seenDiffs.get(e.path) ?? new Set<string>(), inv = invert(e.diff), b = body(e.diff);
      this.changedSinceCheck = true;
      if (!this.editedPaths.has(e.path)) { this.editedPaths.add(e.path); why.push(`first edit to ${e.path}`); }
      else if (b && !seen.has(b) && !seen.has(inv)) why.push(`new change to ${e.path}`);               // a change that undoes an earlier one is not new
      seen.add(b); seen.add(inv); this.seenDiffs.set(e.path, seen);
    }
    for (const c of t.calls) {
      if (c.name === "sh" && typeof c.args?.cmd === "string") {
        const n = countFailures(c.args.cmd, c.result);
        if (n !== undefined) {
          this.lastFailures = n;
          if (n < this.bestFail) { why.push(n === 0 ? "the checks pass" : this.bestFail === Infinity ? `baseline measured: ${n} failing` : `failures down to ${n}`); this.bestFail = n; }
          else if (n === 0 && this.everFailed.has(c.args.cmd)) why.push("a failing command now passes");
          else if (n === 0 && this.changedSinceCheck) why.push("a check passes after the latest change");   // verifies new work, even when an earlier check (say, building the original program) already passed
          if (n === 0) this.changedSinceCheck = false;
          if (n > 0) this.everFailed.add(c.args.cmd);
        }
        else if (isInspection(c.args.cmd) && !/^exit=[1-9]/.test(c.result) && this.readNew(inspectedPaths(c.args.cmd).map((p) => "file:" + p))) why.push("read something new");
      } else if ((c.name === "read_file" || c.name === "grep" || c.name === "list_files") && !/^ERROR/.test(c.result)) {
        const k = c.name === "read_file" ? "file:" + norm(String(c.args?.path ?? "")) : c.name + ":" + (c.args?.path ?? c.args?.pattern ?? ""); if (this.readNew([k])) why.push("read something new");
      }
    }
    this.stale = why.length ? 0 : this.stale + 1; this.reasons = why;
    return why;
  }
  /** Record what a read looked at; true when any of it was not looked at before. The same file seen again through another command (read_file, then xxd, then od -c) is not new information. */
  private readNew(keys: string[]): boolean {
    const fresh = keys.filter((k) => !this.reads.has(k)); if (!fresh.length || this.reads.size >= this.readCap) return false;
    for (const k of fresh) this.reads.add(k); return true;
  }
  /** Files were edited and a check passed after the latest edit: the work may be done. */
  get checksPass(): boolean { return this.editedPaths.size > 0 && this.lastFailures === 0 && !this.changedSinceCheck; }
  summary(): string { return `${this.editedPaths.size} file(s) edited so far; failing count ${this.lastFailures === undefined ? "unknown" : this.lastFailures} (best ${this.bestFail === Infinity ? "unknown" : this.bestFail})`; }
}

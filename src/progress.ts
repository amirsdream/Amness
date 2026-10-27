// Is the run actually getting anywhere? Judged from objective signals (failing-test counts, new files edited, new code written), never from what the model says.
// A loop that keeps acting without any of them improving is stagnating, however confident its messages sound.
import { BUILD_CMD, TEST_CMD } from "./ledger.ts";

/** Number of failures in a test/build/lint output, or undefined when it does not look like one. A failing exit code with no readable count counts as 1. */
export function countFailures(cmd: string, result: string): number | undefined {
  if (!TEST_CMD.test(cmd) && !BUILD_CMD.test(cmd)) return undefined;
  const exit = /^exit=(\d+)/.exec(result)?.[1], out = result;
  const num = (re: RegExp) => { const m = re.exec(out); return m ? Number(m[1]) : undefined; };
  const counts = [num(/(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/i), num(/\bfail(?:ed|ures?|ing)?:\s*(\d+)/i), num(/Tests:\s+(\d+)\s+failed/i), num(/#\s*fail\s+(\d+)/i), num(/ℹ\s*fail\s+(\d+)/i), num(/failures=(\d+)/i)].filter((x): x is number => x !== undefined);
  const ts = (out.match(/\berror TS\d+/g) ?? []).length, lint = num(/(\d+)\s+problems?\b/i), errs = num(/\b(\d+)\s+errors?\b/i);
  const total = (counts.length ? Math.max(...counts) : 0) + ts + (lint ?? 0) + (counts.length || ts || lint ? 0 : errs ?? 0);
  if (total > 0) return total;
  return exit && exit !== "0" ? 1 : 0;
}

/** The inverse of a unified diff hunk set (swap + and -), as a comparable string. */
const invert = (diff: string) => diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).map((l) => (l[0] === "+" ? "-" : "+") + l.slice(1)).sort().join("\n");
const body = (diff: string) => diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).sort().join("\n");

export type TurnFacts = { calls: { name: string; args: any; result: string }[]; edits: { path: string; diff: string }[] };

export class ProgressTracker {
  private bestFail = Infinity; private everFailed = new Set<string>(); private editedPaths = new Set<string>(); private seenDiffs = new Map<string, Set<string>>(); private reads = new Set<string>();
  /** Turns in a row without an objective improvement. */
  stale = 0; lastFailures: number | undefined; reasons: string[] = [];
  private readCap: number;
  constructor(readCap = 15) { this.readCap = readCap; }

  /** Feed one turn; returns why it counted as progress (empty = it did not). */
  observe(t: TurnFacts): string[] {
    const why: string[] = [];
    for (const e of t.edits) {
      const seen = this.seenDiffs.get(e.path) ?? new Set<string>(), inv = invert(e.diff), b = body(e.diff);
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
          if (n > 0) this.everFailed.add(c.args.cmd);
        }
      } else if ((c.name === "read_file" || c.name === "grep" || c.name === "list_files") && !/^ERROR/.test(c.result)) {
        const k = c.name + ":" + (c.args?.path ?? c.args?.pattern ?? ""); if (!this.reads.has(k) && this.reads.size < this.readCap) { this.reads.add(k); why.push("read something new"); }
      }
    }
    this.stale = why.length ? 0 : this.stale + 1; this.reasons = why;
    return why;
  }
  summary(): string { return `${this.editedPaths.size} file(s) edited so far; failing count ${this.lastFailures === undefined ? "unknown" : this.lastFailures} (best ${this.bestFail === Infinity ? "unknown" : this.bestFail})`; }
}

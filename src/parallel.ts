// Several agents at once, each in its own git worktree so they cannot disturb each other or your working tree. Two uses:
//   bestOfN       the same task attempted up to n times; a candidate must pass your verify command, then ties are broken by extra checks, an optional judge, and diff size.
//                 By default attempts run one at a time and stop at the first pass (escalation), so the extra cost is only paid for tasks that need it.
//   parallelParts independent parts of a task run concurrently; each part must pass verify in its own worktree, and parts are then merged one at a time through verify again.
//                 A part that conflicts or breaks verify after merging is reverted and reported, never left half-applied.
// Budgets are explicit: every attempt reports its tokens, and no new attempt starts once the cap is reached.
import { runShell } from "./code.ts";
import type { Model } from "./harness.ts";
import { applyDiff, createWorktree, removeWorktree, revertDiff, worktreeDiff, type Worktree } from "./worktree.ts";

export type Attempt = { summary?: string; tokens?: number };
export type Candidate = { index: number; diff: string; tokens: number; summary?: string; passed: boolean; extraPassed: number; verifyOutput: string; error?: string };
const passes = async (cmd: string | undefined, dir: string) => { if (!cmd) return { ok: true, out: "" }; const out = await runShell(cmd, dir, 300_000); return { ok: out.startsWith("exit=0"), out }; };
const lines = (d: string) => d.split("\n").length;

/** What an attempt did, in a few lines, without a model call: its summary, the files it changed, and the end of its verify output.
 * Later attempts start from the summaries of failed ones, and the judge compares these instead of whole transcripts ("Scaling Test-Time Compute for Agentic Coding", arXiv 2604.16529). */
export function rolloutSummary(c: Candidate): string {
  const files = [...c.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const added = (c.diff.match(/^\+(?!\+\+)/gm) ?? []).length, removed = (c.diff.match(/^-(?!--)/gm) ?? []).length;
  const tail = c.verifyOutput.trim().split("\n").slice(-6).join("\n");
  return [`Attempt ${c.index + 1}: ${c.error ? `crashed (${c.error.slice(0, 200)})` : !c.diff ? "changed nothing" : c.passed ? "passed verify" : "failed verify"}`,
    c.diff ? `Changed: ${files.join(", ") || "(binary or renamed files)"} (+${added} -${removed})` : "",
    c.summary ? `It said: ${c.summary.slice(0, 600)}` : "",
    !c.passed && tail ? `Verify output (end):\n${tail}` : ""].filter(Boolean).join("\n");
}

/** Pick one item by comparing small groups and letting the group winners meet again (Recursive Tournament Voting). `pick` returns the index within the group it is given; a bad answer keeps the first. */
export async function tournament<T>(items: T[], pick: (group: T[]) => Promise<number>, size = 3): Promise<T | undefined> {
  let round = items;
  while (round.length > 1) {
    const next: T[] = [];
    for (let i = 0; i < round.length; i += size) {
      const g = round.slice(i, i + size);
      if (g.length === 1) { next.push(g[0]); continue; }
      const k = await pick(g).catch(() => 0);
      next.push(g[Number.isInteger(k) && k >= 0 && k < g.length ? k : 0]);
    }
    round = next;
  }
  return round[0];
}

export type BestOfNOptions = {
  repo: string; n: number;
  /** Do the work in `dir` (a fresh worktree of HEAD). `index` is 0-based. `earlier` holds the summaries of the attempts that failed before it (one at a time only), so it can avoid their mistakes. */
  attempt: (dir: string, index: number, earlier: string[]) => Promise<Attempt>;
  /** The user's verify command: a candidate that fails it is never chosen. */
  verify?: string;
  /** Extra commands (for example generated tests): among passing candidates, the one passing most of these wins. */
  extraChecks?: string[];
  /** Optional judge over the passing candidates that are still tied: it gets a small group (with `rolloutSummary` of each) and returns the position of its pick in that group.
   * More than `groupSize` candidates are compared in a tournament. Without a judge, the smallest diff wins. */
  judge?: (group: Candidate[]) => Promise<number>;
  /** Candidates per comparison in the tournament (default 3). */
  groupSize?: number;
  /** Stop starting attempts after this many tokens in total. */
  maxTokens?: number;
  /** Run all n at once instead of one by one until one passes. Costs n attempts every time. */
  parallel?: boolean;
  /** Apply the winner's diff to `repo`. */
  apply?: boolean;
  onCandidate?: (c: Candidate) => void;
};
export type BestOfNResult = { winner?: Candidate; candidates: Candidate[]; tokens: number; stoppedForBudget: boolean; applied?: boolean; applyError?: string };

export async function bestOfN(o: BestOfNOptions): Promise<BestOfNResult> {
  const candidates: Candidate[] = []; let tokens = 0, stoppedForBudget = false;
  const one = async (index: number) => {
    const w = await createWorktree(o.repo); const c: Candidate = { index, diff: "", tokens: 0, passed: false, extraPassed: 0, verifyOutput: "" };
    try {
      const earlier = o.parallel ? [] : candidates.filter((x) => !x.passed).map(rolloutSummary);
      const a = await o.attempt(w.dir, index, earlier); c.tokens = a.tokens ?? 0; c.summary = a.summary;
      c.diff = await worktreeDiff(w);
      if (c.diff) { const v = await passes(o.verify, w.dir); c.passed = v.ok; c.verifyOutput = v.out.slice(0, 1500); if (c.passed) for (const x of o.extraChecks ?? []) if ((await passes(x, w.dir)).ok) c.extraPassed++; }
    } catch (e) { c.error = (e as Error).message; } finally { await removeWorktree(w); }
    tokens += c.tokens; candidates.push(c); o.onCandidate?.(c); return c;
  };
  if (o.parallel) await Promise.all(Array.from({ length: o.n }, (_, i) => one(i)));
  else for (let i = 0; i < o.n; i++) {
    if (o.maxTokens !== undefined && tokens >= o.maxTokens) { stoppedForBudget = true; break; }
    const c = await one(i); if (c.passed && !(o.extraChecks?.length)) break;       // with extra checks, a first pass is still compared against later ones only if it missed some
    if (c.passed && c.extraPassed === (o.extraChecks?.length ?? 0)) break;
  }
  candidates.sort((a, b) => a.index - b.index);
  let pool = candidates.filter((c) => c.passed);
  const best = Math.max(0, ...pool.map((c) => c.extraPassed)); pool = pool.filter((c) => c.extraPassed === best);
  if (pool.length > 1 && o.judge) { const w = await tournament(pool, o.judge, o.groupSize ?? 3); if (w) pool = [w]; }
  const winner = pool.sort((a, b) => lines(a.diff) - lines(b.diff) || a.index - b.index)[0];
  const res: BestOfNResult = { winner, candidates, tokens, stoppedForBudget };
  if (o.apply && winner) { const err = await applyDiff(o.repo, winner.diff); res.applied = !err; res.applyError = err; }
  return res;
}

export type Part = { name: string; task: string };
export type PartResult = { part: Part; status: "merged" | "failed-verify" | "conflict" | "broke-verify" | "no-change" | "error" | "skipped-budget"; tokens: number; summary?: string; detail?: string };
export type ParallelOptions = {
  repo: string; parts: Part[];
  attempt: (part: Part, dir: string) => Promise<Attempt>;
  verify?: string; maxTokens?: number; concurrency?: number; onPart?: (r: PartResult) => void;
};
export async function parallelParts(o: ParallelOptions): Promise<{ results: PartResult[]; tokens: number }> {
  type Done = { part: Part; diff: string; tokens: number; summary?: string; res?: PartResult };
  const done: Done[] = []; let tokens = 0, next = 0;
  const worker = async () => {
    while (next < o.parts.length) {
      const part = o.parts[next++];
      if (o.maxTokens !== undefined && tokens >= o.maxTokens) { done.push({ part, diff: "", tokens: 0, res: { part, status: "skipped-budget", tokens: 0, detail: "token cap reached before this part started" } }); continue; }
      const w: Worktree = await createWorktree(o.repo); const d: Done = { part, diff: "", tokens: 0 };
      try {
        const a = await o.attempt(part, w.dir); d.tokens = a.tokens ?? 0; d.summary = a.summary; tokens += d.tokens; d.diff = await worktreeDiff(w);
        if (!d.diff) d.res = { part, status: "no-change", tokens: d.tokens, summary: a.summary };
        else { const v = await passes(o.verify, w.dir); if (!v.ok) d.res = { part, status: "failed-verify", tokens: d.tokens, summary: a.summary, detail: v.out.slice(0, 800) }; }
      } catch (e) { d.res = { part, status: "error", tokens: d.tokens, detail: (e as Error).message }; } finally { await removeWorktree(w); }
      done.push(d);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? o.parts.length, o.parts.length)) }, worker));
  done.sort((a, b) => o.parts.indexOf(a.part) - o.parts.indexOf(b.part));
  const results: PartResult[] = [];
  for (const d of done) {                                      // merge strictly one at a time, in the order given
    let r = d.res;
    if (!r) {
      const err = await applyDiff(o.repo, d.diff);
      if (err) r = { part: d.part, status: "conflict", tokens: d.tokens, summary: d.summary, detail: err.slice(0, 400) };
      else { const v = await passes(o.verify, o.repo); if (v.ok) r = { part: d.part, status: "merged", tokens: d.tokens, summary: d.summary }; else { await revertDiff(o.repo, d.diff); r = { part: d.part, status: "broke-verify", tokens: d.tokens, summary: d.summary, detail: v.out.slice(0, 800) }; } }
    }
    results.push(r); o.onPart?.(r);
  }
  return { results, tokens };
}

/** The task text for an attempt that follows failed ones: the task, then what the earlier attempts did and why they failed (Parallel-Distill-Refine, arXiv 2604.16529). */
export const withEarlier = (task: string, earlier: string[]) =>
  earlier.length ? `${task}\n\n## Earlier attempts at this task failed verification. Learn from them and do not repeat what did not work:\n\n${earlier.join("\n\n")}` : task;

/** A judge that asks `model` which of a few passing attempts best does the task, from their summaries and diffs. Returns the position of its pick (0 if the answer is unclear). */
export function modelJudge(model: Model, task: string, maxDiff = 4000): (group: Candidate[]) => Promise<number> {
  return async (group) => {
    const body = group.map((c, i) => `### Candidate ${i + 1}\n${rolloutSummary(c)}\n\n\`\`\`diff\n${c.diff.slice(0, maxDiff)}${c.diff.length > maxDiff ? "\n… (diff cut)" : ""}\n\`\`\``).join("\n\n");
    const m = await model([{ role: "system", content: "You review alternative solutions to one coding task. All of them pass the tests. Prefer the one that does exactly what the task asks, completely, in the real code (not a demo or a copy), with the least risk. Reply with the number of the best candidate only." },
      { role: "user", content: `Task:\n${task}\n\n${body}\n\nWhich candidate is best? Reply with its number only.` }], []);
    const n = Number(/\d+/.exec(m.content ?? "")?.[0]);
    return n >= 1 && n <= group.length ? n - 1 : 0;
  };
}

// Background tasks: start a task, keep working, and hear when it is done. Each task is its own agent in its own git worktree, so it never edits
// the files you (or another task) are working on. Nobody is there to approve, so edits inside the worktree are allowed and risky commands are
// refused with a reason. When a task ends you get a notice; `/bg apply <n>` brings its changes into your working tree, `/bg drop <n>` throws them away.
// Shared by the terminal and the desktop app (both run the same App).
import { Budget, applyDiff, createSessionWorktree, isRepo, removeWorktree, worktreeDiff, type Event } from "../../src/index.ts";

export type BgStatus = "running" | "done" | "failed" | "stopped";
export type BgTask = {
  id: number; task: string; status: BgStatus; started: number; ended?: number;
  dir: string; branch: string; repo: string;
  /** what the agent said at the end (or the error) */ summary?: string; steps: number; tokens: number;
  /** files changed in the worktree, when it ended */ changed?: string[];
  /** the last thing it did, for the list */ doing?: string;
  ac: AbortController;
};
export type BgAgent = (o: { dir: string; task: string; budget: Budget; signal: AbortSignal; onEvent: (e: Event) => void }) => Promise<{ text: string; finished: boolean; steps: number }>;

export type BgOptions = { cwd: string; run: BgAgent; maxTokens: () => number; onChange?: () => void; onEnd?: (t: BgTask) => void; /** most tasks running at once (default 3) */ max?: number };

export class BackgroundTasks {
  tasks: BgTask[] = []; private next = 1; private o: BgOptions;
  constructor(o: BgOptions) { this.o = o; }

  running() { return this.tasks.filter((t) => t.status === "running"); }
  get(id: number) { return this.tasks.find((t) => t.id === id); }

  /** Start a task in a new worktree. Throws with a reason the user can act on. */
  async start(task: string): Promise<BgTask> {
    if (!task.trim()) throw new Error("say what the background task should do: /bg <task>");
    if (!(await isRepo(this.o.cwd))) throw new Error("background tasks need a git repository with a commit: each one works in its own worktree, so it cannot clash with your files");
    if (this.running().length >= (this.o.max ?? 3)) throw new Error(`${this.o.max ?? 3} background tasks are already running; wait for one, or stop one with /bg stop <n>`);
    const id = this.next++, slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
    const wt = await createSessionWorktree(this.o.cwd, `bg-${id}-${slug}-${Date.now().toString(36).slice(-4)}`);
    const t: BgTask = { id, task, status: "running", started: Date.now(), dir: wt.dir, branch: wt.branch, repo: wt.repo, steps: 0, tokens: 0, ac: new AbortController() };
    this.tasks.push(t); this.o.onChange?.();
    const budget = new Budget({ maxTokens: this.o.maxTokens() });
    void this.o.run({ dir: wt.dir, task, budget, signal: t.ac.signal, onEvent: (e) => {
      if (e.kind === "turn") { t.steps = e.step + 1; t.tokens = budget.tokens; }
      else if (e.kind === "toolstart") t.doing = e.name;
      this.o.onChange?.();
    } }).then(async (r) => {
      t.summary = r.text; t.status = t.ac.signal.aborted ? "stopped" : r.finished ? "done" : "failed"; t.steps = r.steps; t.tokens = budget.tokens;
    }).catch((e) => { t.summary = `error: ${(e as Error).message}`; t.status = t.ac.signal.aborted ? "stopped" : "failed"; })
      .finally(async () => {
        t.ended = Date.now(); t.doing = undefined;
        try { t.changed = [...(await worktreeDiff(this.wt(t))).matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]); } catch { t.changed = []; }
        this.o.onChange?.(); this.o.onEnd?.(t);
      });
    return t;
  }
  stop(id: number): string { const t = this.get(id); if (!t) return `no background task ${id}`; if (t.status !== "running") return `task ${id} is not running (${t.status})`; t.ac.abort(); return `stopping task ${id}`; }
  /** Bring a finished task's changes into the main working tree, then remove its worktree. */
  async apply(id: number): Promise<string> {
    const t = this.get(id); if (!t) return `no background task ${id}`;
    if (t.status === "running") return `task ${id} is still running; wait for it, or /bg stop ${id}`;
    const diff = await worktreeDiff(this.wt(t)); if (!diff.trim()) { await this.drop(id); return `task ${id} changed nothing; its worktree is removed`; }
    const err = await applyDiff(this.o.cwd, diff); if (err) return `task ${id}'s changes do not apply cleanly to your files (${err.split("\n")[0]}). They stay on branch ${t.branch} in ${t.dir}; merge them yourself, or /bg drop ${id}`;
    await this.drop(id, true); return `applied task ${id}: ${t.changed?.length ?? 0} file(s) changed in your working tree (${(t.changed ?? []).slice(0, 6).join(", ")}); /undo does not cover this, use git to review it`;
  }
  /** Throw a task's worktree and branch away. */
  async drop(id: number, applied = false): Promise<string> {
    const t = this.get(id); if (!t) return `no background task ${id}`;
    if (t.status === "running") t.ac.abort();
    await removeWorktree(this.wt(t)); this.tasks = this.tasks.filter((x) => x !== t); this.o.onChange?.();
    return applied ? "" : `dropped task ${id}`;
  }
  /** Stop every running task (the app is closing). Worktrees stay, so nothing finished is lost. */
  stopAll() { for (const t of this.running()) t.ac.abort(); }
  private wt(t: BgTask) { return { dir: t.dir, repo: t.repo }; }
}

/** One line per task, for /bg and the desktop list. */
export function bgLine(t: BgTask, now = Date.now()): string {
  const secs = Math.round(((t.ended ?? now) - t.started) / 1000), mark = { running: "●", done: "✓", failed: "✗", stopped: "■" }[t.status];
  return `${mark} ${t.id}. ${t.task.replace(/\s+/g, " ").slice(0, 60)}  · ${t.status}${t.status === "running" && t.doing ? ` (${t.doing})` : ""} · ${t.steps} steps · ${secs}s${t.changed?.length ? ` · ${t.changed.length} file(s) changed` : ""}`;
}

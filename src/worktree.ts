// Git worktrees: an isolated copy of the repository at HEAD, so an agent can edit freely without touching the working tree. The result comes back as a diff.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, args: string[], input?: string): Promise<string> =>
  new Promise((res, rej) => { const p = execFile("git", args, { cwd, maxBuffer: 64 << 20 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim().split("\n")[0])) : res(out))); if (input !== undefined) { p.stdin?.end(input); } });

export type Worktree = { dir: string; /** the repository it was made from */ repo: string };

/** True inside a git repository with at least one commit. */
export async function isRepo(cwd: string): Promise<boolean> { try { await git(cwd, ["rev-parse", "--verify", "HEAD"]); return true; } catch { return false; } }

/** A detached worktree of HEAD in a fresh temp folder. Uncommitted work in the main tree is NOT included (the isolated agent starts from the last commit). */
export async function createWorktree(repo: string): Promise<Worktree> {
  const root = (await git(repo, ["rev-parse", "--show-toplevel"])).trim(), dir = mkdtempSync(join(tmpdir(), "amness-wt-"));
  try { await git(root, ["worktree", "add", "--detach", dir, "HEAD"]); } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { dir, repo: root };
}

/** Everything changed in the worktree relative to its starting commit, as one unified diff (new files included). */
export async function worktreeDiff(w: Worktree): Promise<string> {
  await git(w.dir, ["add", "-A", "-N", "."]).catch(() => {});                                  // make new files show up in the diff without staging content
  return (await git(w.dir, ["diff", "--no-color", "--no-ext-diff", "HEAD"])).trimEnd();
}

export async function removeWorktree(w: Worktree): Promise<void> {
  await git(w.repo, ["worktree", "remove", "--force", w.dir]).catch(() => {});
  rmSync(w.dir, { recursive: true, force: true }); await git(w.repo, ["worktree", "prune"]).catch(() => {});
}

/** Apply a unified diff to a working tree (atomically: `git apply --check` first). Returns what failed, or undefined. */
export async function applyDiff(cwd: string, diff: string): Promise<string | undefined> {
  if (!diff.trim()) return undefined;
  try { await git(cwd, ["apply", "--check", "--whitespace=nowarn", "-"], diff + "\n"); await git(cwd, ["apply", "--whitespace=nowarn", "-"], diff + "\n"); return undefined; } catch (e) { return (e as Error).message; }
}

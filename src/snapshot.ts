// Reversible shell commands. Before an agent runs a command that may change files, the whole working tree (tracked and untracked, ignored files excluded) is recorded as a git
// TREE OBJECT using a private index file: no commit, no branch, no stash, the user's index and history are never touched. `restoreTree` puts the working tree back exactly
// (files restored, files the command created removed). Effects outside the workspace and on other systems cannot be restored, so such commands are named instead.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> =>
  new Promise((res, rej) => { const p = execFile("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 256 << 20 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim().split("\n")[0])) : res(out))); if (input !== undefined) p.stdin?.end(input); });
const EXCLUDE = [":(exclude).amness", ":(exclude).git"];

/** Commands whose effects reach beyond the working tree, so undo cannot take them back. */
const IRREVERSIBLE: [RegExp, string][] = [
  [/\bgit\s+(?:-\S+\s+)*push\b/, "pushes commits to a remote"], [/\b(?:npm|pnpm|yarn)\s+(?:publish|deprecate|unpublish)\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, "publishes a package"],
  [/\bdocker\s+(?:push|rm|rmi|system\s+prune|volume\s+rm)\b|\bdocker-compose\s+down\s+-v\b/, "changes or deletes containers or images"], [/\bkubectl\s+(?:apply|delete|replace|scale|rollout|patch)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+(?:up|destroy)\b/, "changes live infrastructure"],
  [/\baws\s+\S+\s+(?:create|delete|put|update|terminate|remove|run|start|stop)\w*|\bgcloud\s+.*\b(?:create|delete|update|deploy)\b|\baz\s+.*\b(?:create|delete|update)\b/, "changes a cloud account"],
  [/\bcurl\b[^|;&]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-d\b|--data\b|-F\b|--upload-file|-T\b)/i, "sends data to a server"],
  [/\b(?:psql|mysql|sqlite3|mongo|mongosh|redis-cli)\b[^|;&]*(?:drop|delete|truncate|update|insert|alter|flushall|flushdb|set\b)/i, "writes to a database"],
  [/\b(?:ssh|scp|rsync)\b/, "acts on another machine"], [/\bsendmail\b|\bmail\s+-s\b|\bslack\b[^|;&]*(?:post|send)/i, "sends a message"],
  [/\brm\s+(?:-\S+\s+)*(?:\/|~|\$HOME|\.\.\/)/, "deletes outside the workspace"], [/(?:>|>>|\btee\b)\s*(?:\/(?!tmp\b|dev\/null\b)|~\/)/, "writes outside the workspace"],
];
export function irreversibleReason(cmd: string): string | undefined { return IRREVERSIBLE.find(([re]) => re.test(cmd))?.[1]; }

export type SnapshotResult = { restored: string[]; removed: string[] };
export class Snapshots {
  private cwd: string; private ok?: boolean; private gitDir = "";
  constructor(cwd: string) { this.cwd = resolve(cwd); }

  /** Snapshots need a git repository (with or without commits). */
  async available(): Promise<boolean> {
    if (this.ok !== undefined) return this.ok;
    try { this.gitDir = resolve(this.cwd, (await git(this.cwd, ["rev-parse", "--git-dir"])).trim()); this.ok = true; } catch { this.ok = false; }
    return this.ok;
  }
  private index() { return join(this.gitDir, "amness-snapshot.index"); }

  /** Record the working tree as a tree object and return its id (undefined when there is no git repository or git fails). */
  async take(): Promise<string | undefined> {
    if (!(await this.available())) return undefined;
    try {
      const env = { GIT_INDEX_FILE: this.index() };
      await git(this.cwd, ["add", "-A", "--", ".", ...EXCLUDE], env);
      return (await git(this.cwd, ["write-tree"], env)).trim();
    } catch { return undefined; }
  }

  /** Paths in the working tree that differ from the snapshot (changed, deleted, or created since). */
  async changedSince(tree: string): Promise<string[]> {
    const now = await this.take(); if (!now || now === tree) return [];
    const out = await git(this.cwd, ["diff-tree", "-r", "--name-only", "-z", tree, now]); return out.split("\0").filter(Boolean);
  }

  /** Put the working tree back to `tree`: restore files that were changed or deleted, remove files that were created (only those git would see: ignored files are never touched). */
  async restore(tree: string): Promise<SnapshotResult> {
    if (!(await this.available())) throw new Error("not a git repository");
    const changed = await this.changedSince(tree), restored: string[] = [], removed: string[] = [];
    if (!changed.length) return { restored, removed };
    const inTree = new Set((await git(this.cwd, ["ls-tree", "-r", "--name-only", "-z", tree])).split("\0").filter(Boolean));
    const tmp = mkdtempSync(join(tmpdir(), "amness-restore-")), env = { GIT_INDEX_FILE: join(tmp, "index") };
    try {
      await git(this.cwd, ["read-tree", tree], env);
      for (const p of changed) {
        const abs = resolve(this.cwd, p); if (abs !== this.cwd && !abs.startsWith(this.cwd + sep)) continue;
        if (inTree.has(p)) { mkdirSync(dirname(abs), { recursive: true }); await git(this.cwd, ["checkout-index", "-f", "--", p], env); restored.push(p); }
        else if (existsSync(abs) && statSync(abs).isFile()) { rmSync(abs); removed.push(p); }
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    return { restored, removed };
  }
}

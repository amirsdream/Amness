// `amness run --background` and `amness tasks`: a headless run that keeps going after the command returns, in its own git worktree,
// with its events in .amness/background/<id>.jsonl and its outcome in <id>.json. You keep working; a system notification says when it ends.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyDiff, createSessionWorktree, isRepo, removeWorktree, worktreeDiff } from "../src/index.ts";
import { notify } from "./tui/notify.ts";
import { BOOL_FLAGS, VALUE_FLAGS } from "./headless.ts";

export type BgRun = { id: string; task: string; cwd: string; repo: string; branch?: string; dir: string; pid?: number; started: string; ended?: string; status: "running" | "done" | "failed" | "stopped"; text?: string; tokens?: number; steps?: number };
const folder = (repo: string) => join(repo, ".amness", "background");
const read = (f: string): BgRun | undefined => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** Start `amness run <argv>` detached. In a git repository it runs in a new worktree unless `--here` is given. Prints where to follow it. */
export async function startBackground(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== "--background" && a !== "--here"), here = argv.includes("--here");
  const ci = args.indexOf("--cwd"), cwd = resolve(ci >= 0 ? args[ci + 1] ?? "." : ".");
  const task = (() => { const rest: string[] = []; for (let i = 0; i < args.length; i++) { if (VALUE_FLAGS.has(args[i])) { i++; continue; } if (BOOL_FLAGS.has(args[i]) || args[i] === "--live") continue; rest.push(args[i]); } return rest.join(" ").trim(); })();
  if (!task.trim() || task.trim() === "-") { console.error("amness run --background needs the task on the command line (not from standard input)"); return 2; }
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 7)}`;
  let dir = cwd, branch: string | undefined, repo = cwd;
  if (!here && (await isRepo(cwd))) { const wt = await createSessionWorktree(cwd, `run-${id}`); dir = wt.dir; branch = wt.branch; repo = wt.repo; }
  const out = folder(repo); mkdirSync(out, { recursive: true });
  const log = openSync(join(out, `${id}.jsonl`), "a");
  const childArgs = [...process.execArgv, process.argv[1], "run", ...(ci >= 0 ? [...args.slice(0, ci), ...args.slice(ci + 2)] : args), "--cwd", dir, ...(args.includes("--json") ? [] : ["--json"])];
  const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, AMNESS_BACKGROUND_ID: id, AMNESS_BACKGROUND_DIR: out } });
  const rec: BgRun = { id, task, cwd, repo, branch, dir, pid: child.pid, started: new Date().toISOString(), status: "running" };
  writeFileSync(join(out, `${id}.json`), JSON.stringify(rec, null, 1)); child.unref();
  console.log(`started background run ${id}${branch ? ` on branch ${branch} (its own worktree, so it will not touch your files)` : here ? " in this folder" : " in this folder (not a git repository, so it works on your files)"}`);
  console.log(`follow it:   amness tasks ${id}        log: ${join(out, `${id}.jsonl`)}`);
  return 0;
}

/** Called at the end of a background run (inside the child): record the outcome and send a notification. */
export function finishBackground(r: { finished: boolean; text: string; steps?: number; tokens?: number; stopped?: string }) {
  const id = process.env.AMNESS_BACKGROUND_ID, dir = process.env.AMNESS_BACKGROUND_DIR; if (!id || !dir) return;
  const f = join(dir, `${id}.json`), rec = read(f); if (!rec) return;
  Object.assign(rec, { ended: new Date().toISOString(), status: r.stopped === "aborted" ? "stopped" : r.finished ? "done" : "failed", text: r.text, steps: r.steps, tokens: r.tokens });
  writeFileSync(f, JSON.stringify(rec, null, 1));
  if (process.env.AMNESS_NOTIFY !== "off") try { notify({ write: () => true }, `Amness: background run ${rec.status === "done" ? "finished" : rec.status}`, `${rec.task.slice(0, 80)} · amness tasks ${id}`, { kind: "os" }); } catch { /* no notifier */ }
}

/** Every background run of this repository, newest first. A run whose process is gone without a result counts as stopped. */
export function listRuns(repo: string): BgRun[] {
  const d = folder(repo); if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => read(join(d, f))).filter((r): r is BgRun => !!r)
    .map((r) => (r.status === "running" && !alive(r.pid) ? { ...r, status: "stopped" as const } : r)).sort((a, b) => b.started.localeCompare(a.started));
}

export const TASKS_HELP = `amness tasks                 list background runs (amness run --background "<task>")
amness tasks <id>            show one: status, result, log, branch
amness tasks --apply <id>    take its changes into your working tree (then its worktree is removed)
amness tasks --drop <id>     throw its worktree and branch away
amness tasks --stop <id>     stop a run that is still going`;

export async function runTasks(argv: string[], cwd = process.cwd()): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(TASKS_HELP); return 0; }
  let repo = resolve(cwd); try { const { execFileSync } = await import("node:child_process"); repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || repo; } catch { /* not a repository */ }
  const runs = listRuns(repo), flag = ["--apply", "--drop", "--stop"].find((f) => argv.includes(f)), idArg = flag ? argv[argv.indexOf(flag) + 1] : argv.find((a) => !a.startsWith("--"));
  const run = idArg ? runs.find((r) => r.id === idArg || r.id.endsWith(idArg)) : undefined;
  if (!idArg) {
    if (!runs.length) { console.log('no background runs here. Start one: amness run --background "<task>"'); return 0; }
    for (const r of runs) console.log(`${{ running: "●", done: "✓", failed: "✗", stopped: "■" }[r.status]} ${r.id}  ${r.status.padEnd(8)} ${r.task.replace(/\s+/g, " ").slice(0, 60)}${r.branch ? `  (${r.branch})` : ""}`);
    return 0;
  }
  if (!run) { console.error(`no background run ${idArg}`); return 2; }
  if (flag === "--stop") { if (run.status !== "running" || !run.pid) { console.log(`${run.id} is not running`); return 0; } try { process.kill(-run.pid, "SIGTERM"); } catch { try { process.kill(run.pid, "SIGTERM"); } catch { /* gone */ } } console.log(`stopping ${run.id}`); return 0; }
  if (flag && run.status === "running") { console.error(`${run.id} is still running; wait for it, or amness tasks --stop ${run.id}`); return 2; }
  if (flag && !run.branch) { console.error(`${run.id} ran in your folder, so its changes are already there`); return 2; }
  if (flag === "--drop") { await removeWorktree({ dir: run.dir, repo: run.repo }); try { const { execFileSync } = await import("node:child_process"); execFileSync("git", ["branch", "-D", run.branch!], { cwd: run.repo, stdio: "ignore" }); } catch { /* gone */ } console.log(`dropped ${run.id}`); return 0; }
  if (flag === "--apply") {
    const diff = await worktreeDiff({ dir: run.dir, repo: run.repo }); if (!diff.trim()) { console.log(`${run.id} changed nothing`); return 0; }
    const err = await applyDiff(run.cwd, diff); if (err) { console.error(`the changes do not apply cleanly (${err.split("\n")[0]}); they stay on branch ${run.branch}`); return 1; }
    await removeWorktree({ dir: run.dir, repo: run.repo }); console.log(`applied ${run.id}: ${[...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]).join(", ")}`); return 0;
  }
  console.log([`run      ${run.id}`, `task     ${run.task}`, `status   ${run.status}${run.ended ? ` (ended ${run.ended})` : ""}`, `where    ${run.dir}${run.branch ? `  (branch ${run.branch})` : ""}`, `log      ${join(folder(run.repo), `${run.id}.jsonl`)}`, "", run.text ?? "(no result yet)", "",
    run.branch && run.status !== "running" ? `take its changes: amness tasks --apply ${run.id}   ·   throw them away: amness tasks --drop ${run.id}` : ""].join("\n"));
  return 0;
}

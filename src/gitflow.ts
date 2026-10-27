// Review and pull-request helpers around git and the GitHub CLI. Nothing here talks to the network without being asked: a PR is only created after the caller confirms.
import { execFile } from "node:child_process";
import type { Model } from "./harness.ts";
import { parseLooseJson } from "./schema.ts";

const run = (cwd: string, file: string, args: string[]): Promise<string> => new Promise((res, rej) => execFile(file, args, { cwd, maxBuffer: 64 << 20 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim().split("\n")[0])) : res(out))));

/** The branch a PR would target: origin's default branch, else main/master, else HEAD's parent branch is unknown. */
export async function defaultBase(cwd: string): Promise<string | undefined> {
  try { const r = (await run(cwd, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim(); if (r) return r; } catch { /* no origin/HEAD */ }
  for (const b of ["origin/main", "origin/master", "main", "master"]) { try { await run(cwd, "git", ["rev-parse", "--verify", "--quiet", b]); return b; } catch { /* try next */ } }
  return undefined;
}
export const currentBranch = async (cwd: string) => (await run(cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();

/** Everything changed relative to `base` (default: the PR base, or HEAD when none): committed work on the branch plus uncommitted and untracked files, as one diff. */
export async function diffForReview(cwd: string, base?: string): Promise<{ diff: string; against: string }> {
  const against = base ?? (await defaultBase(cwd)) ?? "HEAD";
  await run(cwd, "git", ["add", "-A", "-N", "."]).catch(() => {});
  const mergeBase = against === "HEAD" ? "HEAD" : (await run(cwd, "git", ["merge-base", against, "HEAD"]).catch(() => against)).trim();
  return { diff: (await run(cwd, "git", ["diff", "--no-color", "--no-ext-diff", mergeBase])).trimEnd(), against };
}
export async function commitLog(cwd: string, base: string, max = 30): Promise<string> { return (await run(cwd, "git", ["log", "--no-color", `--max-count=${max}`, "--format=%s", `${base}..HEAD`]).catch(() => "")).trim(); }

export type PrDraft = { title: string; body: string };
/** Ask a model for a PR title and body from the commits and the diff. The text is a DRAFT for the user to see before anything is created. */
export async function draftPr(model: Model, o: { diff: string; log: string; branch: string }): Promise<PrDraft> {
  const m = await model([{ role: "system", content: "You write pull request descriptions. Reply with ONLY JSON: {\"title\": string (under 70 characters, imperative mood), \"body\": string (markdown: what changed and why, how it was verified if the diff shows tests, anything a reviewer should look at closely)}. Describe what the diff really does; do not invent tests or claims." }, { role: "user", content: `Branch: ${o.branch}\n\nCommit subjects:\n${o.log || "(none)"}\n\nDiff:\n${o.diff.slice(0, 40_000)}${o.diff.length > 40_000 ? "\n[... diff truncated]" : ""}` }], []);
  let j: { title?: unknown; body?: unknown } | null = null as { title?: unknown; body?: unknown } | null; try { j = parseLooseJson(m.content ?? "") as { title?: unknown; body?: unknown } | null; } catch { /* not JSON */ }
  if (!j || typeof j.title !== "string" || !j.title.trim()) throw new Error("the model did not return a usable title and body");
  return { title: j.title.trim().slice(0, 120), body: typeof j.body === "string" ? j.body.trim() : "" };
}

/** `gh pr create`. Only call this after the user confirmed. Returns the URL gh prints. */
export async function createPr(cwd: string, d: PrDraft, o: { base?: string; draft?: boolean } = {}): Promise<string> {
  const base = o.base?.replace(/^origin\//, "");
  const out = await run(cwd, "gh", ["pr", "create", "--title", d.title, "--body", d.body, ...(base ? ["--base", base] : []), ...(o.draft ? ["--draft"] : [])]);
  return out.trim().split("\n").pop() ?? "";
}
export async function hasUpstream(cwd: string): Promise<boolean> { try { await run(cwd, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); return true; } catch { return false; } }
export const pushBranch = (cwd: string) => run(cwd, "git", ["push", "-u", "origin", "HEAD"]);

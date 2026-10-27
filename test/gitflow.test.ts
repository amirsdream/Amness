import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitLog, createPr, createSessionWorktree, currentBranch, defaultBase, diffForReview, draftPr, hasUpstream, removeWorktree, worktreeIsUntouched, type Model } from "../src/index.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString().trim();
function pair() {                      // a bare "origin" and a clone with a feature branch
  const o = mkdtempSync(join(tmpdir(), "amness-or-")), d = mkdtempSync(join(tmpdir(), "amness-cl-"));
  git(o, "init", "-q", "--bare", "-b", "main"); git(d, "init", "-q", "-b", "main"); git(d, "remote", "add", "origin", o);
  writeFileSync(join(d, "a.txt"), "one\n"); git(d, "add", "."); git(d, "commit", "-qm", "init"); git(d, "push", "-q", "-u", "origin", "main"); git(d, "remote", "set-head", "origin", "main");
  return { o, d };
}

test("gitflow: base branch, current branch, and a review diff that includes commits, uncommitted and untracked work", async () => {
  const { d } = pair(); assert.equal(await defaultBase(d), "origin/main"); git(d, "checkout", "-q", "-b", "feat");
  writeFileSync(join(d, "a.txt"), "two\n"); git(d, "commit", "-qam", "change a"); writeFileSync(join(d, "b.txt"), "new file\n"); writeFileSync(join(d, "a.txt"), "three\n");
  assert.equal(await currentBranch(d), "feat"); assert.equal(await commitLog(d, "origin/main"), "change a");
  const { diff, against } = await diffForReview(d); assert.equal(against, "origin/main"); assert.match(diff, /-one[\s\S]*\+three/); assert.match(diff, /b\.txt[\s\S]*\+new file/); assert.equal(await hasUpstream(d), false);
  assert.match((await diffForReview(d, "HEAD")).diff, /\+new file/);
});

test("draftPr parses the model's JSON and refuses unusable output; createPr calls gh with the title, body, base and draft flag", async () => {
  const ok: Model = async () => ({ role: "assistant", content: '```json\n{"title": "Fix the thing", "body": "## What\\nFixed."}\n```' });
  assert.deepEqual(await draftPr(ok, { diff: "d", log: "l", branch: "b" }), { title: "Fix the thing", body: "## What\nFixed." });
  await assert.rejects(draftPr(async () => ({ role: "assistant", content: "sure, here you go" }), { diff: "", log: "", branch: "b" }), /usable title/);
  const bin = mkdtempSync(join(tmpdir(), "amness-gh-")), log = join(bin, "args.txt"); writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\necho https://github.com/o/r/pull/7\n`); chmodSync(join(bin, "gh"), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try { const url = await createPr(process.cwd(), { title: "T", body: "B" }, { base: "origin/main", draft: true }); assert.equal(url, "https://github.com/o/r/pull/7"); assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["pr", "create", "--title", "T", "--body", "B", "--base", "main", "--draft"]); } finally { process.env.PATH = old; }
});

test("session worktree: its own branch under .amness/worktrees; untouched ones are detected, ones with edits or commits are not", async () => {
  const { d } = pair(), w = await createSessionWorktree(d, "try it!"); assert.equal(w.branch, "amness/try-it"); assert.ok(existsSync(join(w.dir, "a.txt")) && w.dir.includes(".amness/worktrees"));
  assert.equal(await worktreeIsUntouched(w.dir, w.base), true);
  writeFileSync(join(w.dir, "x.txt"), "x\n"); assert.equal(await worktreeIsUntouched(w.dir, w.base), false);
  git(w.dir, "add", "."); git(w.dir, "commit", "-qm", "work"); assert.equal(await worktreeIsUntouched(w.dir, w.base), false);                    // clean tree, but there is a commit
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "one\n"); assert.ok(!existsSync(join(d, "x.txt")));
  await assert.rejects(createSessionWorktree(d, "!!!"), /needs a name/);
  await removeWorktree({ dir: w.dir, repo: w.repo });
});

test("TUI: /pr drafts, shows the text, asks before creating, offers to push first, and calls gh only after yes", async () => {
  const { call, say, rig, KEY } = await import("./helpers/apprig.ts");
  const { d } = pair(); git(d, "checkout", "-q", "-b", "feat"); writeFileSync(join(d, "a.txt"), "two\n"); git(d, "commit", "-qam", "make it two");
  const bin = mkdtempSync(join(tmpdir(), "amness-gh2-")), log = join(bin, "args.txt"); writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo gh 2; exit 0; fi\nprintf '%s\\n' "$@" > ${log}\necho https://github.com/o/r/pull/9\n`); chmodSync(join(bin, "gh"), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const t = rig([say('{"title": "Make it two", "body": "Changes a.txt to two."}')], { cols: 120, rows: 40, ui: "full" });
    // run the app in the repository: the rig creates its own folder, so point the command at ours
    (t.app as any).cwd = d; await t.start();
    await t.submit("/pr"); assert.ok(await t.until(() => t.has("Create this pull request"), 6000), t.screen()); assert.ok(t.has("Make it two") && t.has("Changes a.txt to two."));
    assert.ok(!existsSync(log));                                                               // nothing created yet
    await t.key(KEY.enter);                                                                    // "Create it"
    assert.ok(await t.until(() => t.has("not on the remote yet"), 5000)); await t.key(KEY.enter);   // "Yes, push it"
    assert.ok(await t.until(() => t.has("created: https://github.com/o/r/pull/9"), 8000), t.screen());
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").slice(0, 5), ["pr", "create", "--title", "Make it two", "--body"]); assert.equal(await hasUpstream(d), true);
  } finally { process.env.PATH = old; }
});

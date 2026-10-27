import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshots, irreversibleReason, runShell } from "../src/index.ts";
import { rewindFull, newSession, type Turn } from "../cli/tui/session.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString().trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), "amness-sn-")); git(d, "init", "-q");
  writeFileSync(join(d, ".gitignore"), "build/\nnode_modules/\n"); writeFileSync(join(d, "a.txt"), "one\n"); mkdirSync(join(d, "src")); writeFileSync(join(d, "src/b.js"), "b\n");
  git(d, "add", "."); git(d, "commit", "-qm", "init"); return d;
}

test("snapshot: a shell command that rewrites, deletes and creates files is undone exactly; ignored files and the real git index are left alone", async () => {
  const d = repo(), s = new Snapshots(d); mkdirSync(join(d, "build")); writeFileSync(join(d, "build/out.js"), "built\n"); writeFileSync(join(d, "scratch.txt"), "untracked before\n");
  const indexBefore = git(d, "status", "--porcelain");
  const tree = await s.take(); assert.match(tree!, /^[0-9a-f]{40}$/); assert.equal(git(d, "status", "--porcelain"), indexBefore);        // taking a snapshot changes nothing visible
  await runShell("echo changed > a.txt && rm src/b.js && echo new > created.txt && mkdir -p deep/er && echo x > deep/er/f.txt && echo more >> scratch.txt && echo gone > build/out.js", d);
  assert.deepEqual((await s.changedSince(tree!)).sort(), ["a.txt", "created.txt", "deep/er/f.txt", "scratch.txt", "src/b.js"]);               // build/ is ignored: not part of the picture
  const r = await s.restore(tree!);
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "one\n"); assert.equal(readFileSync(join(d, "src/b.js"), "utf8"), "b\n"); assert.equal(readFileSync(join(d, "scratch.txt"), "utf8"), "untracked before\n");
  assert.ok(!existsSync(join(d, "created.txt")) && !existsSync(join(d, "deep/er/f.txt")));
  assert.equal(readFileSync(join(d, "build/out.js"), "utf8"), "gone\n");                                                                          // ignored output is not ours to restore
  assert.deepEqual(r.removed.sort(), ["created.txt", "deep/er/f.txt"]); assert.equal((await s.changedSince(tree!)).length, 0); assert.equal(git(d, "status", "--porcelain"), indexBefore);
});

test("snapshot: no git repository means no snapshot, and restoring says why", async () => {
  const d = mkdtempSync(join(tmpdir(), "amness-ng-")), s = new Snapshots(d);
  assert.equal(await s.take(), undefined); await assert.rejects(s.restore("abc"), /not a git repository/);
});

test("irreversibleReason names commands whose effects reach beyond the workspace", () => {
  for (const [c, why] of [["git push origin main", /pushes commits/], ["npm publish", /publishes a package/], ["kubectl delete pod x", /live infrastructure/], ["terraform apply -auto-approve", /live infrastructure/], ["curl -X POST https://api.example.com/x -d '{}'", /sends data/], ["psql -c 'DROP TABLE users'", /writes to a database/], ["ssh prod 'systemctl restart app'", /another machine/], ["rm -rf ~/old", /outside the workspace/], ["echo x > /etc/hosts", /outside the workspace/], ["docker push img", /containers or images/]] as const)
    assert.match(irreversibleReason(c) ?? "", why, c);
  for (const c of ["npm test", "echo hi > out.txt", "git commit -m x", "ls /tmp", "echo x > /tmp/y", "curl https://example.com"]) assert.equal(irreversibleReason(c), undefined, c);
});

test("rewindFull: undoing a turn restores the shell's changes AND the tool edits, and names what cannot be undone", async () => {
  const d = repo(), s = new Snapshots(d), sess = newSession(d, "m");
  const turn = (text: string, at: number): Turn => ({ at, text, t: 0, snaps: {} });
  sess.messages = [{ role: "user", content: "t1" }, { role: "assistant", content: "a1" }, { role: "user", content: "t2" }, { role: "assistant", content: "a2" }];
  const t1 = turn("t1", 0), t2 = turn("t2", 2); sess.turns = [t1, t2];
  // turn 1: an edit tool changes a.txt (snapshot of the old content); turn 2: the shell rewrites things and pushes
  t1.snaps["a.txt"] = "one\n"; writeFileSync(join(d, "a.txt"), "edited by tool\n");
  t2.shell = { tree: await s.take(), cmds: ["make clean && git push"], irreversible: ["git push (pushes commits to a remote)"] };
  await runShell("rm src/b.js && echo made > made.txt && echo shell >> a.txt", d);
  const r = await rewindFull(sess, d, 1, s);                                                                 // undo only turn 2
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "edited by tool\n"); assert.equal(readFileSync(join(d, "src/b.js"), "utf8"), "b\n"); assert.ok(!existsSync(join(d, "made.txt")));
  assert.deepEqual(r.irreversible, ["git push (pushes commits to a remote)"]); assert.equal(sess.turns.length, 1);
  const all = await rewindFull(sess, d, 0, s); assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "one\n");         // and now turn 1's edit
  assert.equal(all.tree, undefined);
});

test("TUI: /undo after a turn whose shell command changed files puts the working tree back, and says what it undid", async () => {
  const { call, say, rig } = await import("./helpers/apprig.ts");
  const t = rig([call("sh", { cmd: "echo changed > a.txt && touch new.txt && git push origin main 2>/dev/null; true" }), say("done")], { cols: 130, rows: 40, ui: "full", files: { "a.txt": "original\n" } });
  git(t.dir, "init", "-q"); git(t.dir, "add", "."); git(t.dir, "commit", "-qm", "init");
  await t.start(); t.app.setMode("yolo"); await t.submit("change things"); await t.until(() => t.idle() && t.has("done"));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "changed\n"); assert.ok(existsSync(join(t.dir, "new.txt")));
  await t.submit("/undo"); await t.settle(400);
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "original\n"); assert.ok(!existsSync(join(t.dir, "new.txt")));
  assert.ok(t.has("undid shell changes") || t.has("rewound the conversation"), t.screen());
});

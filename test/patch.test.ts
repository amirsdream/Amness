import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Permissions, applyOps, codeTools, parsePatch, patchPaths, replaceMany, replaceOnce, type Event, type Tool } from "../src/index.ts";

const files = (m: Record<string, string>) => (p: string) => m[p];

test("patch: the Codex envelope parses update, add, delete and move; unified diffs parse too", () => {
  const ops = parsePatch("*** Begin Patch\n*** Update File: src/a.ts\n@@ function f\n ctx\n-old\n+new\n*** Add File: src/b.ts\n+line1\n+line2\n*** Delete File: src/c.ts\n*** Update File: d.ts\n*** Move to: e.ts\n@@\n-x\n+y\n*** End Patch");
  assert.deepEqual(ops.map((o) => [o.op, o.path, o.moveTo]), [["update", "src/a.ts", undefined], ["add", "src/b.ts", undefined], ["delete", "src/c.ts", undefined], ["update", "d.ts", "e.ts"]]);
  assert.equal(ops[0].hunks[0].anchor, "function f"); assert.deepEqual(ops[1].hunks[0].lines.map((l) => l.s), ["line1", "line2"]);
  const u = parsePatch("--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+hello\n");
  assert.deepEqual(u.map((o) => [o.op, o.path]), [["update", "x.js"], ["add", "new.js"]]);
  assert.deepEqual(patchPaths("*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n-x\n+y\n*** End Patch"), ["a", "b"]);
});

test("patch: applies across files; hunks apply in order; anchors narrow the search; a failing hunk changes nothing and is named", () => {
  const src = { "a.ts": "function f() {\n  return 1;\n}\nfunction g() {\n  return 1;\n}\n", "b.ts": "x\ny\n" };
  const ok = applyOps(parsePatch("*** Begin Patch\n*** Update File: a.ts\n@@ function g() {\n-  return 1;\n+  return 2;\n*** Update File: b.ts\n@@\n x\n-y\n+z\n*** Add File: c.ts\n+new\n*** End Patch"), files(src));
  assert.deepEqual(ok.errors, []); assert.equal(ok.applied[0].after, "function f() {\n  return 1;\n}\nfunction g() {\n  return 2;\n}\n"); assert.equal(ok.applied[1].after, "x\nz\n"); assert.equal(ok.applied[2].after, "new\n");
  const bad = applyOps(parsePatch("*** Begin Patch\n*** Update File: a.ts\n@@\n-  return 1;\n+  return 9;\n*** Update File: b.ts\n@@\n-nope\n+z\n*** End Patch"), files(src));
  assert.deepEqual(bad.applied, []); assert.match(bad.errors[0], /b\.ts, hunk 1: the lines to replace were not found/); assert.equal(bad.errors.length, 1);
  assert.match(applyOps(parsePatch("*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch"), files(src)).errors[0], /already exists/);
  assert.match(applyOps(parsePatch("*** Begin Patch\n*** Update File: zzz.ts\n@@\n-a\n+b\n*** End Patch"), files(src)).errors[0], /no such file/);
});

test("patch: indentation-only differences are matched when unique and re-indented; trailing newline state is kept; unified hunks use line hints", () => {
  const file = { "a.py": "def f():\n    if x:\n        return 1\n    return 0\n" };
  const r = applyOps(parsePatch("*** Begin Patch\n*** Update File: a.py\n@@\n-if x:\n-    return 1\n+if y:\n+    return 2\n*** End Patch"), files(file));
  assert.equal(r.applied[0].after, "def f():\n    if y:\n        return 2\n    return 0\n"); assert.equal(r.applied[0].fuzzy, 1);
  assert.equal(applyOps(parsePatch("--- a/a.py\n+++ b/a.py\n@@ -4,1 +4,1 @@\n-    return 0\n+    return -1\n"), files(file)).applied[0].after, "def f():\n    if x:\n        return 1\n    return -1\n");
  assert.equal(applyOps(parsePatch("*** Begin Patch\n*** Update File: n.txt\n@@\n-a\n+b\n*** End Patch"), files({ "n.txt": "a" })).applied[0].after, "b");     // no trailing newline stays none
});

test("edit text: unique exact match; ambiguity and misses explain themselves; indentation-tolerant when unique; many edits are all-or-nothing", () => {
  assert.deepEqual(replaceOnce("a\nb\nc", "b", "B"), { out: "a\nB\nc" });
  assert.match((replaceOnce("x x", "x", "y") as { error: string }).error, /matched 2 times/);
  assert.match((replaceOnce("abc", "zzz", "y") as { error: string }).error, /not found/);
  assert.deepEqual(replaceOnce("  if (a) {\n    go();\n  }\n", "if (a) {\n  go();\n}", "if (b) {\n  stop();\n}"), { out: "  if (b) {\n    stop();\n  }\n", fuzzy: true });
  assert.match((replaceOnce("if (a) {\n go();\n}\nif (a) {\n  go();\n}\n", "if (a) {\n    go();\n}", "z") as { error: string }).error, /2 places match ignoring indentation/);
  assert.deepEqual(replaceMany("1 2 3", [{ old: "1", new: "one" }, { old: "3", new: "three" }]), { out: "one 2 three", fuzzy: 0 });
  assert.match((replaceMany("1 2 3", [{ old: "1", new: "one" }, { old: "9", new: "x" }]) as { error: string }).error, /edit 2 of 2/);
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-pt-")); mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n"); writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");
  const tools = codeTools(dir), by = (n: string) => tools.find((t) => t.name === n) as Tool, ev: Event[] = [], ctx = { registry: undefined as any, step: 0, emit: (e: Event) => ev.push(e) };
  return { dir, by, ev, ctx, read: async (p: string) => by("read_file").run({ path: p }, ctx) };
};

test("apply_patch tool: multi-file, atomic, read-before-edit enforced, one edit event per file", async () => {
  const s = setup();
  assert.match(String(await Promise.resolve().then(() => s.by("apply_patch").run({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export const a = 1;\n+export const a = 10;\n*** End Patch" }, s.ctx)).catch((e: Error) => e.message)), /read src\/a\.ts/);
  await s.read("src/a.ts"); await s.read("src/b.ts");
  const bad = String(await s.by("apply_patch").run({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export const a = 1;\n+export const a = 10;\n*** Update File: src/b.ts\n@@\n-missing\n+x\n*** End Patch" }, s.ctx));
  assert.match(bad, /ERROR: nothing was changed/); assert.equal(readFileSync(join(s.dir, "src/a.ts"), "utf8"), "export const a = 1;\n");        // the first file was NOT touched
  const ok = String(await s.by("apply_patch").run({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export const a = 1;\n+export const a = 10;\n*** Add File: src/c.ts\n+export const c = 3;\n*** Delete File: src/b.ts\n*** End Patch" }, s.ctx));
  assert.match(ok, /patched 3 file\(s\)[\s\S]*updated src\/a\.ts[\s\S]*added src\/c\.ts[\s\S]*deleted src\/b\.ts/);
  assert.equal(readFileSync(join(s.dir, "src/a.ts"), "utf8"), "export const a = 10;\n"); assert.ok(existsSync(join(s.dir, "src/c.ts")) && !existsSync(join(s.dir, "src/b.ts")));
  assert.deepEqual(s.ev.filter((e) => e.kind === "edit").map((e: any) => e.path), ["src/a.ts", "src/c.ts", "src/b.ts"]);
  assert.match(String(await Promise.resolve().then(() => s.by("apply_patch").run({ patch: "*** Begin Patch\n*** Add File: ../escape.ts\n+x\n*** End Patch" }, s.ctx)).catch((e: Error) => e.message)), /escapes the workspace/);
});

test("edit_file tool: edits list is all-or-nothing and the old/new form still works", async () => {
  const s = setup(); await s.read("src/a.ts");
  assert.match(String(await s.by("edit_file").run({ path: "src/a.ts", edits: [{ old: "a = 1", new: "a = 5" }, { old: "nope", new: "x" }] }, s.ctx)), /ERROR: edit 2 of 2/);
  assert.equal(readFileSync(join(s.dir, "src/a.ts"), "utf8"), "export const a = 1;\n");
  assert.match(String(await s.by("edit_file").run({ path: "src/a.ts", edits: [{ old: "a = 1", new: "a = 5" }, { old: "export", new: "export default" }] }, s.ctx)), /edited src\/a\.ts \(2 edits\)/);
  assert.equal(readFileSync(join(s.dir, "src/a.ts"), "utf8"), "export default const a = 5;\n");
  assert.match(String(await s.by("edit_file").run({ path: "src/a.ts", old: "a = 5", new: "a = 6" }, s.ctx)), /edited src\/a\.ts:/);
  assert.match(String(await s.by("edit_file").run({ path: "src/a.ts" }, s.ctx)), /give `old` and `new`/);
});

test("permissions: a patch is judged file by file (floor, deny, ask, allow)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "amness-pp2-")), p = new Permissions({ allow: ["edit(src/**)"], deny: ["edit(secrets/**)"], ask: ["edit(docs/**)"] }, cwd);
  const patch = (...paths: string[]) => ({ patch: "*** Begin Patch\n" + paths.map((x) => `*** Update File: ${x}\n@@\n-a\n+b`).join("\n") + "\n*** End Patch" });
  assert.equal(p.check("apply_patch", patch("src/a.ts", "src/b.ts")).action, "allow");
  assert.equal(p.check("apply_patch", patch("src/a.ts", "lib/x.ts")).action, "none");
  assert.equal(p.check("apply_patch", patch("src/a.ts", "secrets/k")).action, "deny");
  assert.equal(p.check("apply_patch", patch("src/a.ts", "docs/r.md")).action, "ask");
  assert.equal(p.check("apply_patch", patch("src/a.ts", ".git/config")).floor, true);
  assert.equal(p.check("apply_patch", patch(".amness/permissions.json")).action, "deny");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileOpenCommand, filesIn, findRows } from "../cli/tui/find.ts";
import { KEY, rig, say } from "./helpers/apprig.ts";

const mouse = (b: number, x: number, y: number, up = false) => `\x1b[<${b};${x};${y}${up ? "m" : "M"}`;

test("findRows: every match, case-insensitive, with columns in cells (wide characters counted)", () => {
  assert.deepEqual(findRows(["Find me", "nothing", "find FIND"], "find"), [{ row: 0, col: 0, w: 4 }, { row: 2, col: 0, w: 4 }, { row: 2, col: 5, w: 4 }]);
  assert.deepEqual(findRows(["日本 find"], "find"), [{ row: 0, col: 5, w: 4 }]);
  assert.deepEqual(findRows(["x"], ""), []);
});

test("filesIn: real paths with an optional line; version numbers, urls and unknown files are not paths", () => {
  const real = new Set(["src/app.ts", "README.md"]), exists = (p: string) => real.has(p);
  assert.deepEqual(filesIn("see src/app.ts:12 and README.md, not lib/x.ts or 1.2.3", exists).map((f) => [f.path, f.line]), [["src/app.ts", 12], ["README.md", undefined]]);
  assert.deepEqual(filesIn("https://example.com/src/app.ts", exists), []);
});

test("fileOpenCommand: GUI editors open at the line in their own window, terminal editors take the screen", () => {
  assert.deepEqual(fileOpenCommand("code --wait", "/p/a.ts", 7), { cmd: 'code --wait -g "/p/a.ts:7"', terminal: false });
  assert.deepEqual(fileOpenCommand("nvim", "/p/a.ts", 7), { cmd: 'nvim +7 "/p/a.ts"', terminal: true });
  assert.deepEqual(fileOpenCommand("idea", "/p/a.ts", 7), { cmd: 'idea --line 7 "/p/a.ts"', terminal: false });
  assert.equal(fileOpenCommand("", "/p/a.ts", 1, "darwin").cmd, 'open "/p/a.ts"');
});

test("ctrl+f finds text in the conversation live, newest match first; arrows move between matches; esc goes back", async () => {
  const t = rig([say("first needle here"), say("second needle there")], { cols: 100, rows: 30, ui: "full" }); await t.start();
  await t.submit("a"); assert.ok(await t.until(() => t.idle())); await t.submit("b"); assert.ok(await t.until(() => t.idle()));
  await t.key("\x06"); await t.type("needle"); await t.settle();
  assert.ok(t.has("2/2"), t.screen());
  await t.key(KEY.up); await t.settle(); assert.ok(t.has("1/2"));
  await t.key(KEY.up); await t.settle(); assert.ok(t.has("2/2"));                // wraps around
  await t.type("zzz"); await t.settle(); assert.ok(t.has("no match"));
  await t.key(KEY.esc); await t.settle(); assert.ok(!t.has("no match") && !t.app.full!.find);
  await t.key(KEY.ctrlD);
});

test("a file path in a reply opens in the editor on click, at its line", async () => {
  const saved = process.env.VISUAL; process.env.VISUAL = "code";
  const t = rig([say("The bug is in src/app.ts:2 right now.")], { cols: 100, rows: 30, ui: "full", files: { "src/app.ts": "a\nb\n" } }); await t.start();
  const ran: string[] = []; t.app.runEditor = (cmd) => { ran.push(cmd); };
  try {
    await t.submit("where?"); assert.ok(await t.until(() => t.idle() && t.has("src/app.ts:2")));
    const rows = t.screen().split("\n"), y = rows.findIndex((r) => r.includes("src/app.ts:2")), x = rows[y].indexOf("src/app.ts:2");
    await t.key(mouse(0, x + 3, y + 1)); await t.key(mouse(0, x + 3, y + 1, true)); await t.settle();
    assert.equal(ran.length, 1, t.screen()); assert.match(ran[0], /^code -g ".*src[\\/]+app\.ts:2"$/);                // Windows paths use \ (JSON-escaped as \\)
  } finally { if (saved === undefined) delete process.env.VISUAL; else process.env.VISUAL = saved; await t.key(KEY.ctrlD); }
});

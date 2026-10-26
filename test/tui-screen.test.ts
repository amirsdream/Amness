import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen } from "../cli/tui/screen.ts";
import { clipAnsi, cellWidth, strip } from "../cli/tui/text.ts";
import { estimateCost, contextWindow, fmtCost, fmtDuration, fmtTokens } from "../cli/tui/pricing.ts";
import { VTerm } from "./helpers/vterm.ts";

const rig = (cols = 40, rows = 10) => { const vt = new VTerm(cols, rows); const out = { write: (s: string) => vt.write(s), columns: cols, rows }; return { vt, scr: new Screen(out) }; };

test("screen: committed lines land in scrollback above exactly one live region", () => {
  const { vt, scr } = rig();
  scr.frame(["hello", "world"], ["── input ──", "❯ typing", "footer"], { row: 1, col: 10 });
  assert.deepEqual(vt.screen(), ["hello", "world", "── input ──", "❯ typing", "footer"]);
  assert.deepEqual([vt.r, vt.c], [3, 10]);                                            // cursor parked inside the input line
  scr.frame(["third"], ["── input ──", "❯ typing more", "footer"], { row: 1, col: 14 });
  assert.deepEqual(vt.screen(), ["hello", "world", "third", "── input ──", "❯ typing more", "footer"]);
});

test("screen: live region can grow and shrink without leaving residue", () => {
  const { vt, scr } = rig();
  scr.frame([], ["a", "b", "c", "d", "e"], { row: 4, col: 1 });
  scr.frame([], ["a", "b"], { row: 1, col: 1 });
  assert.deepEqual(vt.screen(), ["a", "b"]);
  scr.frame([], ["x", "y", "z"], { row: 0, col: 0 });
  assert.deepEqual(vt.screen(), ["x", "y", "z"]); assert.deepEqual([vt.r, vt.c], [0, 0]);
  scr.frame(["done"], [], undefined);
  assert.deepEqual(vt.screen(), ["done"]);
});

test("screen: lots of output scrolls into history while the live region stays pinned to the bottom", () => {
  const { vt, scr } = rig(30, 8);
  for (let i = 1; i <= 20; i++) scr.frame([`line ${i}`], ["─── box ───", "❯ _", "status"], { row: 1, col: 3 });
  const all = vt.all();
  assert.deepEqual(all.filter((l) => l.startsWith("line ")).length, 20);              // nothing lost, nothing duplicated
  assert.equal(new Set(all.filter((l) => l.startsWith("line "))).size, 20);
  assert.deepEqual(vt.screen().slice(-3), ["─── box ───", "❯ _", "status"]);
  assert.equal(all.filter((l) => l === "─── box ───").length, 1);                    // exactly one copy of the region, ever
});

test("screen: a live region taller than the terminal is trimmed from the top, not allowed to scroll", () => {
  const { vt, scr } = rig(30, 6);
  scr.frame([], Array.from({ length: 12 }, (_, i) => `row${i}`), { row: 11, col: 0 });
  assert.equal(vt.screen().length, 5); assert.equal(vt.screen().at(-1), "row11"); assert.equal(vt.scrollback.length, 0);
});

test("screen: over-wide live lines are clipped so the region never wraps; clear() removes it", () => {
  const { vt, scr } = rig(20, 8);
  scr.frame(["c"], ["x".repeat(60), "\x1b[31m" + "y".repeat(60) + "\x1b[0m"], { row: 0, col: 2 });
  assert.ok(vt.screen().every((l) => cellWidth(l) <= 20)); assert.equal(vt.screen().length, 3);
  scr.clear(); assert.deepEqual(vt.screen(), ["c"]);
});

test("screen: wide characters keep cursor math right", () => {
  const { vt, scr } = rig(40, 6);
  scr.frame([], ["❯ 漢字"], { row: 0, col: 2 + 4 });
  assert.deepEqual([vt.r, vt.c], [0, 6]);
});

test("clipAnsi keeps escapes balanced and appends an ellipsis only when cut", () => {
  assert.equal(clipAnsi("short", 10), "short");
  const c = clipAnsi("\x1b[31m" + "z".repeat(30) + "\x1b[0m", 10);
  assert.equal(cellWidth(c), 10); assert.ok(strip(c).endsWith("…")); assert.ok(c.endsWith("\x1b[0m"));
});

test("pricing: known models cost something sensible; unknown models report nothing; formatting helpers", () => {
  assert.equal(estimateCost("claude-opus-5-5", 1_000_000, 1_000_000), 24);
  assert.equal(estimateCost("claude-haiku-5-5", 1_000_000, 0), 0.1);
  assert.equal(estimateCost("gpt-4.1-mini", 1e6, 1e6), 2);
  assert.equal(estimateCost("my-local-model", 5, 5), null); assert.equal(contextWindow("my-local-model"), 128_000); assert.equal(contextWindow("claude-opus-5-5"), 1_000_000);
  assert.deepEqual([fmtCost(0.004), fmtCost(1.234), fmtCost(null)], ["<$0.01", "$1.23", ""]);
  assert.deepEqual([fmtTokens(950), fmtTokens(1500), fmtTokens(48_000), fmtTokens(2_500_000)], ["950", "1.5k", "48k", "2.5M"]);
  assert.deepEqual([fmtDuration(4200), fmtDuration(65_000)], ["4s", "1m 5s"]);
});

test("screen: after the window narrows (old rows re-wrap), the next frame still erases the whole old region", () => {
  // emulate a terminal that re-wraps its contents when resized: rebuild a narrower VTerm from the rows that were on screen
  const wide = new VTerm(40, 12), out = { write: (s: string) => wide.write(s), columns: 40, rows: 12 }, scr = new Screen(out);
  const region = ["═".repeat(36), "❯ " + "x".repeat(30), "y".repeat(36)];
  scr.frame(["scrollback line"], region, { row: 1, col: 10 });
  const narrow = new VTerm(20, 12);
  for (const row of wide.screen()) narrow.write(row + "\r\n");                       // what a reflowing terminal would show now
  narrow.r = 1 + 2 + 2; narrow.c = 10 % 20;                                          // cursor is on the (now wrapped) input line
  const scr2 = new Screen({ write: (s: string) => narrow.write(s), columns: 20, rows: 12 });
  (scr2 as any).height = 3; (scr2 as any).cursorRow = 1; (scr2 as any).cursorCol = 10; (scr2 as any).lastCols = 40; (scr2 as any).lastWidths = region.map(cellWidthOf);
  scr2.frame([], ["═".repeat(16), "❯ new", "footer"], { row: 1, col: 5 });
  const screen = narrow.screen();
  assert.deepEqual(screen.filter((l) => /[═xy]{5,}/.test(l) && !l.startsWith("═".repeat(16))), []);   // no remnants of the old, wider region
  assert.ok(screen.includes("❯ new") && screen.includes("footer"));
});
const cellWidthOf = (s: string) => cellWidth(s);

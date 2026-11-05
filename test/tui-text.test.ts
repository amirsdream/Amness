import { test } from "node:test";
import assert from "node:assert/strict";
import { cellWidth, clipAnsi, graphemes, wrapAnsi } from "../cli/tui/text.ts";
import { parseAnsi } from "../cli/tui/ansi.ts";

test("emoji are measured as the terminal draws them: joined, skin tone, flags, emoji style, newer emoji", () => {
  const cases: [string, number][] = [["abc", 3], ["✅", 2], ["👨‍👩‍👧", 2], ["👍🏽", 2], ["🇩🇪", 2], ["☺️", 2], ["é", 1], ["日本", 4], ["🫠", 2], ["\x1b[1m✅\x1b[0m ok", 5]];
  for (const [s, w] of cases) assert.equal(cellWidth(s), w, JSON.stringify(s));
  assert.deepEqual(graphemes("a👨‍👩‍👧b"), ["a", "👨‍👩‍👧", "b"]);
});

test("wrapping and clipping never split a joined emoji", () => {
  const rows = wrapAnsi("ab 👨‍👩‍👧 cd 👨‍👩‍👧", 6);
  for (const r of rows) assert.ok(cellWidth(r) <= 6, r);
  assert.ok(rows.join("").includes("👨‍👩‍👧"));
  assert.equal(clipAnsi("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 5), "👨‍👩‍👧👨‍👩‍👧…");
});

test("the cell parser keeps a joined emoji in one double-width cell", () => {
  const cells = parseAnsi("x👨‍👩‍👧y");
  assert.deepEqual(cells.map((c) => [c.ch, c.w]), [["x", 1], ["👨‍👩‍👧", 2], ["y", 1]]);
});

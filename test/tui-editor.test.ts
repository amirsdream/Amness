import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../cli/tui/editor.ts";

const ed = (t = "") => { const e = new Editor(); e.insert(t); return e; };

test("editor: insert, newline, backspace across lines, delete, cursor motion", () => {
  const e = ed("hello"); e.newline(); e.insert("world");
  assert.deepEqual([e.text, e.row, e.col], ["hello\nworld", 1, 5]);
  e.home(); e.backspace(); assert.deepEqual([e.text, e.row, e.col], ["helloworld", 0, 5]);
  e.left(); e.left(); e.del(); assert.equal(e.text, "heloworld");                        // deleted the second 'l'
  e.end(); assert.equal(e.col, e.text.length); e.home(); e.right(); assert.equal(e.col, 1);
  const m = new Editor(); m.insert("a\nb\nc"); assert.deepEqual([m.row, m.col], [2, 1]);
  m.insert("X\nY"); assert.equal(m.text, "a\nb\ncX\nY");
});

test("editor: emoji and CJK move/delete as single characters", () => {
  const e = ed("a🙂b"); e.left(); e.left(); assert.equal(e.col, 1);       // jumped over the whole surrogate pair
  e.right(); e.backspace(); assert.equal(e.text, "ab");
  const c = ed("漢字"); c.backspace(); assert.equal(c.text, "漢");
});

test("editor: word motion and deletion (ctrl-w / alt-backspace, alt-b/f), kill to start/end", () => {
  const e = ed("foo bar_baz  qux");
  e.wordLeft(); assert.equal(e.col, 13); e.wordLeft(); assert.equal(e.col, 4); e.wordRight(); assert.equal(e.col, 11);
  e.end(); e.deleteWordBack(); assert.equal(e.text, "foo bar_baz  ");
  e.home(); e.wordRight(); e.killToEnd(); assert.equal(e.text, "foo");
  const k = ed("one two"); k.left(); k.left(); k.killToStart(); assert.equal(k.text, "wo");
});

test("editor: soft wrap layout and cursor; up/down move by visual row keeping the column", () => {
  const e = ed("aaaa bbbb cccc dddd");
  const lay = e.layout(10);
  assert.deepEqual(lay.rows.map((r) => e.text.slice(r.start, r.end)), ["aaaa bbbb ", "cccc dddd"]);
  assert.deepEqual([lay.cursorRow, lay.cursorCol], [1, 9]);
  e.width = 10;
  assert.equal(e.vertical(-1), true); assert.equal(e.layout(10).cursorRow, 0);
  assert.equal(e.vertical(-1), false);                                       // at the top edge: caller may browse history
  assert.equal(e.vertical(1), true); assert.equal(e.vertical(1), false);
  const two = ed("short\na much longer second line"); two.width = 40;
  two.vertical(-1); assert.deepEqual([two.row, two.col], [0, 5]);            // clamped to the shorter line
  two.vertical(1); assert.deepEqual([two.row, two.col], [1, 25]);                                                     // goal column restored (we started at col 25)
});

test("editor: history recall keeps the draft; submit records, trims, expands, clears", () => {
  const e = new Editor();
  e.insert("first"); assert.equal(e.submit(), "first");
  e.insert("second"); e.submit();
  e.insert("draft");
  assert.equal(e.historyPrev(), true); assert.equal(e.text, "second");
  assert.equal(e.historyPrev(), true); assert.equal(e.text, "first");
  assert.equal(e.historyPrev(), false);
  e.historyNext(); e.historyNext(); assert.equal(e.text, "draft");
  e.clear(); e.insert("second"); e.submit(); assert.deepEqual(e.history, ["second", "first"]);   // de-duplicated against the latest
  assert.equal(e.empty, true);
});

test("editor: big pastes collapse to a placeholder, delete as one unit, and expand on submit", () => {
  const e = new Editor(); const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  e.insert("see: "); e.paste(big);
  assert.equal(e.text, "see: [Pasted text #1 +20 lines]");
  assert.equal(e.submit(), "see: " + big);
  e.paste(big); e.paste("tiny\ntext"); assert.match(e.text, /#2 \+20 lines\]tiny\ntext$/);
  e.clear(); e.paste(big); e.backspace(); assert.equal(e.text, "");
});

test("editor: render gives prompt gutter, continuation indent and a cursor inside the wrapped text", () => {
  const e = ed("hello world, this wraps"); const r = e.render(14);
  assert.ok(r.lines[0].startsWith("❯ ") && r.lines.slice(1).every((l) => l.startsWith("  ")));
  assert.ok(r.lines.length >= 2); assert.equal(r.cursor.row, r.lines.length - 1);
  const empty = new Editor().render(40); assert.deepEqual(empty, { lines: ["❯ "], cursor: { row: 0, col: 2 } });
  const cjk = ed("漢字"); assert.equal(cjk.render(40).cursor.col, 2 + 4);
});

test("editor: setText with numeric cursor positions the caret", () => {
  const e = new Editor(); e.setText("ab\ncd", 4); assert.deepEqual([e.row, e.col, e.cursorIndex], [1, 1, 4]);
});

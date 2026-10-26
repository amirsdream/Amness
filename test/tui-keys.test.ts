import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyParser } from "../cli/tui/keys.ts";
import { cellWidth, clipWidth, strip, wrapAnsi } from "../cli/tui/text.ts";

const keys = (...chunks: string[]) => { const p = new KeyParser(); return chunks.flatMap((c) => p.feed(c)); };

test("keys: printable, enter, tab, backspace, ctrl combos", () => {
  assert.deepEqual(keys("a"), [{ name: "char", text: "a" }]);
  assert.deepEqual(keys("hi"), [{ name: "char", text: "hi" }]);
  assert.deepEqual(keys("\r", "\t", "\x7f"), [{ name: "enter" }, { name: "tab" }, { name: "backspace" }]);
  assert.deepEqual(keys("\x03", "\x04", "\x0f", "\x01"), [{ name: "c", ctrl: true }, { name: "d", ctrl: true }, { name: "o", ctrl: true }, { name: "a", ctrl: true }]);
  assert.deepEqual(keys("\n"), [{ name: "j", ctrl: true }]);                                  // Ctrl+J = newline
  assert.deepEqual(keys("é漢"), [{ name: "char", text: "é漢" }]);
});

test("keys: arrows, home/end, delete, paging, shift-tab, SS3 forms", () => {
  assert.deepEqual(keys("\x1b[A\x1b[B\x1b[C\x1b[D"), [{ name: "up" }, { name: "down" }, { name: "right" }, { name: "left" }]);
  assert.deepEqual(keys("\x1b[H\x1b[F\x1b[3~\x1b[5~\x1b[6~"), [{ name: "home" }, { name: "end" }, { name: "delete" }, { name: "pageup" }, { name: "pagedown" }]);
  assert.deepEqual(keys("\x1b[Z"), [{ name: "backtab" }]);
  assert.deepEqual(keys("\x1bOA\x1bOH"), [{ name: "up" }, { name: "home" }]);
});

test("keys: modifiers (alt/ctrl/shift arrows), alt+enter, alt+backspace, alt+b/f, kitty CSI-u", () => {
  assert.deepEqual(keys("\x1b[1;3D"), [{ name: "left", alt: true }]);
  assert.deepEqual(keys("\x1b[1;5C"), [{ name: "right", ctrl: true }]);
  assert.deepEqual(keys("\x1b[1;2A"), [{ name: "up", shift: true }]);
  assert.deepEqual(keys("\x1b\r"), [{ name: "enter", alt: true }]);
  assert.deepEqual(keys("\x1b\x7f"), [{ name: "backspace", alt: true }]);
  assert.deepEqual(keys("\x1bb\x1bf"), [{ name: "char", text: "b", alt: true }, { name: "char", text: "f", alt: true }]);
  assert.deepEqual(keys("\x1b[13;2u"), [{ name: "enter", shift: true }]);                    // Shift+Enter where the terminal reports it
});

test("keys: lone ESC waits for flush; split sequences are reassembled", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b"), []); assert.equal(p.pending, true);
  assert.deepEqual(p.flush(), [{ name: "escape" }]);
  assert.deepEqual(p.feed("\x1b"), []); assert.deepEqual(p.feed("[1;3"), []); assert.deepEqual(p.feed("D"), [{ name: "left", alt: true }]);
  assert.deepEqual(p.feed("\x1b\x1b"), [{ name: "escape" }]);
});

test("keys: bracketed paste is one event, even split across chunks, with newlines normalised", () => {
  assert.deepEqual(keys("\x1b[200~line1\r\nline2\x1b[201~"), [{ name: "paste", text: "line1\nline2" }]);
  assert.deepEqual(keys("\x1b[200~ab", "cd\nef", "\x1b[201~x"), [{ name: "paste", text: "abcd\nef" }, { name: "char", text: "x" }]);
  assert.deepEqual(keys("\x1b[200~\x1b[A inside\x1b[201~"), [{ name: "paste", text: "\x1b[A inside" }]);   // escapes inside a paste stay text
});

test("keys: an un-bracketed multi-line burst is treated as a paste", () => {
  assert.deepEqual(keys("first line\rsecond line\r"), [{ name: "paste", text: "first line\nsecond line" }]);
  assert.deepEqual(keys("x", "\r"), [{ name: "char", text: "x" }, { name: "enter" }]);                  // normal typing unaffected
});

test("text: display width of wide chars/emoji/combining marks; ANSI ignored", () => {
  assert.deepEqual([cellWidth("abc"), cellWidth("漢字"), cellWidth("á"), cellWidth("\x1b[31mred\x1b[0m"), cellWidth("🙂")], [3, 4, 1, 3, 2]);
  assert.equal(clipWidth("漢字漢字", 5), "漢字"); assert.equal(strip("\x1b[1mhi\x1b[0m"), "hi");
});

test("text: wrapAnsi respects width, keeps words, indents continuation, never exceeds width, doesn't lose text", () => {
  const rows = wrapAnsi("the quick brown fox jumps over the lazy dog", 16, 2);
  assert.ok(rows.every((r) => cellWidth(r) <= 16), JSON.stringify(rows));
  assert.equal(rows.map((r) => r.trim()).join(" "), "the quick brown fox jumps over the lazy dog");
  assert.ok(rows.slice(1).every((r) => r.startsWith("  ")));
  const hard = wrapAnsi("x".repeat(50), 10);
  assert.ok(hard.every((r) => cellWidth(r) <= 10)); assert.equal(hard.join(""), "x".repeat(50));
  const cjk = wrapAnsi("漢字漢字漢字漢字", 8); assert.ok(cjk.every((r) => cellWidth(r) <= 8) && cjk.join("") === "漢字漢字漢字漢字");
  const styled = wrapAnsi("\x1b[1m" + "word ".repeat(10) + "\x1b[0m", 12);
  assert.ok(styled.every((r) => cellWidth(r) <= 12)); assert.ok(styled.slice(0, -1).every((r) => r.endsWith("\x1b[0m")));
});

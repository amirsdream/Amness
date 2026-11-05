import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../cli/tui/editor.ts";
import { Vim } from "../cli/tui/vim.ts";
import { previewLines } from "../cli/tui/session.ts";
import { KEY, rig, say } from "./helpers/apprig.ts";

const keys = (v: Vim, e: Editor, s: string) => { for (const ch of s) v.key(e, { name: "char", text: ch }); };
const start = (text: string, col = 0) => { const e = new Editor(); e.setText(text, col); const v = new Vim(); v.mode = "normal"; return { e, v }; };

test("vim motions: h l w b e 0 $ ^ gg G and counts", () => {
  const { e, v } = start("foo bar baz\n  qux");
  keys(v, e, "w"); assert.equal(e.col, 4); keys(v, e, "2w"); assert.equal(e.col, 11);         // past the last word: end of line
  keys(v, e, "0e"); assert.equal(e.col, 2); keys(v, e, "$"); assert.equal(e.col, 10); keys(v, e, "b"); assert.equal(e.col, 8);
  keys(v, e, "G^"); assert.deepEqual([e.row, e.col], [1, 2]); keys(v, e, "gg"); assert.deepEqual([e.row, e.col], [0, 0]);
  keys(v, e, "3l"); assert.equal(e.col, 3); keys(v, e, "h"); assert.equal(e.col, 2);
});

test("vim edits: x, dw, cw, D, dd, yy + p, u undoes each as one step", () => {
  let { e, v } = start("foo bar baz");
  keys(v, e, "x"); assert.equal(e.text, "oo bar baz");
  keys(v, e, "dw"); assert.equal(e.text, "bar baz");
  keys(v, e, "cw"); assert.equal(v.mode, "insert"); assert.equal(e.text, " baz"); e.insert("X"); assert.equal(e.text, "X baz");
  v.mode = "normal"; keys(v, e, "u"); assert.equal(e.text, " baz"); keys(v, e, "u"); assert.equal(e.text, "bar baz");
  ({ e, v } = start("one\ntwo\nthree", 4));
  keys(v, e, "dd"); assert.equal(e.text, "one\nthree"); assert.equal(v.register, "two\n");
  keys(v, e, "yy"); assert.equal(v.register, "three\n");
  ({ e, v } = start("hello world", 5)); keys(v, e, "D"); assert.equal(e.text, "hello");
  ({ e, v } = start("only")); keys(v, e, "dd"); assert.equal(e.text, "");
});

test("vim: i a A I o O enter insert mode at the right place; enter submits and the next message starts in insert mode", () => {
  let { e, v } = start("  abc", 3);
  keys(v, e, "a"); assert.deepEqual([v.mode, e.col], ["insert", 4]);
  v.mode = "normal"; keys(v, e, "I"); assert.equal(e.col, 2); v.mode = "normal"; keys(v, e, "A"); assert.equal(e.col, 5);
  ({ e, v } = start("a\nb")); keys(v, e, "o"); assert.equal(e.text, "a\n\nb"); assert.equal(e.row, 1);
  ({ e, v } = start("a")); keys(v, e, "O"); assert.equal(e.text, "\na"); assert.deepEqual([e.row, e.col], [0, 0]);
  ({ e, v } = start("x")); assert.equal(v.key(e, { name: "enter" }), "submit"); assert.equal(v.mode, "insert");
  ({ e, v } = start("x")); assert.equal(v.key(e, { name: "char", text: "q" }), true); assert.equal(e.text, "x");     // an unknown key never types
  assert.equal(v.key(e, { name: "backtab" }), false);                                                               // shift+tab still cycles modes
});

test("/vim in the app: Esc goes to normal mode, keys edit, i types again, enter sends", async () => {
  const t = rig([say("ok")]); await t.start();
  await t.submit("/vim on"); await t.type("hello world"); await t.key(KEY.esc); await t.settle(40);
  assert.equal(t.app.vim.mode, "normal");
  await t.type("0dw"); assert.ok(await t.until(() => t.app.editor.text === "world"));
  await t.type("A"); await t.type("!"); assert.equal(t.app.editor.text, "world!");
  await t.key(KEY.enter); assert.ok(await t.until(() => t.idle() && t.has("ok")));
  await t.key(KEY.ctrlD);
});

test("sessions: preview lines show the last exchanges; /rename names a conversation and --resume finds it by name", async () => {
  assert.deepEqual(previewLines({ messages: [{ role: "system", content: "s" }, { role: "user", content: "fix it\n\n<attached>\nx" }, { role: "assistant", content: "Done:\n  fixed" }] }), ["you  fix it", "amness  Done: fixed"]);
  const a = rig([say("first answer")]); a.app.persist = true; await a.start();
  await a.submit("work on the parser"); assert.ok(await a.until(() => a.idle()));
  await a.submit("/rename parser work"); assert.ok(await a.until(() => a.has('renamed to "parser work"')));
  const store = a.app.store; await a.key(KEY.ctrlD);
  assert.equal(store.find("PARSER WORK")?.title, "parser work"); assert.equal(store.find("parser")?.title, "parser work"); assert.equal(store.find("nothing"), undefined);
});

test("vim: a fast burst like 'ihello' enters insert mode and types the rest", () => {
  const { e, v } = start("x");
  v.key(e, { name: "char", text: "Ahello" }); assert.equal(v.mode, "insert"); assert.equal(e.text, "xhello");
});

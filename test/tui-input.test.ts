import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "../cli/tui/editor.ts";
import { KeyParser } from "../cli/tui/keys.ts";
import { PickerOverlay } from "../cli/tui/overlays.ts";
import { editExternally } from "../cli/tui/external.ts";
import { KEY, rig, say } from "./helpers/apprig.ts";

test("undo and redo: typing in one place is one step, a deletion is another, redo goes forward again", () => {
  const e = new Editor();
  for (const ch of "hello") e.insert(ch);
  e.insert(" "); for (const ch of "world") e.insert(ch);
  e.backspace(); e.backspace();
  assert.equal(e.text, "hello wor");
  e.undo(); assert.equal(e.text, "hello worl");
  e.undo(); assert.equal(e.text, "hello world");
  e.undo(); assert.equal(e.text, "hello ");
  e.undo(); assert.equal(e.text, "hello");
  e.undo(); assert.equal(e.text, "");
  assert.equal(e.undo(), false);
  e.redo(); e.redo(); assert.equal(e.text, "hello ");
  e.insert("x"); assert.equal(e.redo(), false);                     // a new change drops the redo steps
});

test("undo: moving the cursor starts a new step; a paste and a cleared buffer are separate steps", () => {
  const e = new Editor();
  e.insert("a"); e.insert("b"); e.left(); e.insert("X");
  assert.equal(e.text, "aXb"); e.undo(); assert.equal(e.text, "ab");
  e.paste("pasted"); e.undo(); assert.equal(e.text, "ab");
  e.clear(); assert.equal(e.undo(), false);
});

test("keys: ctrl+_ is undo, ctrl+z / ctrl+y / ctrl+r / ctrl+g / ctrl+v arrive as ctrl keys", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1f"), [{ name: "_", ctrl: true }]);
  assert.deepEqual(p.feed("\x1a\x19\x12\x07\x16").map((k) => k.name), ["z", "y", "r", "g", "v"]);
});

test("picker: typing filters fuzzily and puts the best match first", () => {
  const p = new PickerOverlay("m", [{ label: "claude-opus-5-5", value: 1 }, { label: "gpt-6.1-sol", value: 2 }, { label: "gpt-4.1", value: 3 }], () => {});
  p.filter = "gsol"; assert.deepEqual(p.visible().map((i) => i.value), [2]);
  p.filter = "gpt"; assert.deepEqual(p.visible().map((i) => i.value).sort(), [2, 3]);
  p.filter = ""; assert.equal(p.visible().length, 3);
});

test("editExternally: the editor's saved text comes back; a failing editor gives undefined", () => {
  const ok = editExternally("draft", { ...process.env, VISUAL: `node -e "require('fs').writeFileSync(process.argv[1], 'edited text\\n')"` });
  assert.equal(ok, "edited text");
  assert.equal(editExternally("draft", { ...process.env, VISUAL: "node -e \"process.exit(3)\"" }), undefined);
});

test("ctrl+r finds an earlier message and puts it in the input", async () => {
  const t = rig([say("one"), say("two")]); await t.start();
  await t.submit("fix the login bug"); assert.ok(await t.until(() => t.idle()));
  await t.submit("add tests for pagination"); assert.ok(await t.until(() => t.idle()));
  await t.key("\x12"); assert.ok(await t.until(() => t.has("Your earlier messages")));
  await t.type("login"); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.app.editor.text === "fix the login bug"));
  await t.key(KEY.ctrlC); await t.key(KEY.ctrlD);
});

test("ctrl+v saves a clipboard image in the project and mentions it; with no image it says so", async () => {
  const t = rig([]); await t.start();
  t.app.readClipboard = () => undefined; await t.key("\x16");
  assert.ok(await t.until(() => t.has("no image on the clipboard")));
  t.app.readClipboard = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); await t.key("\x16");
  const m = /@(\.amness\/paste\/clip-\S+\.png) $/.exec(t.app.editor.text); assert.ok(m, t.app.editor.text);
  assert.ok(existsSync(join(t.app.cwd, m![1]))); assert.equal(readFileSync(join(t.app.cwd, m![1]))[1], 0x50);
  await t.key(KEY.ctrlC); await t.key(KEY.ctrlD);
});

test("ctrl+g edits the message in $VISUAL and brings the result back", async () => {
  const saved = process.env.VISUAL; process.env.VISUAL = `node -e "require('fs').writeFileSync(process.argv[1], 'from my editor')"`;
  const t = rig([]); await t.start();
  try { await t.type("draft"); await t.key("\x07"); assert.ok(await t.until(() => t.app.editor.text === "from my editor")); }
  finally { if (saved === undefined) delete process.env.VISUAL; else process.env.VISUAL = saved; await t.key(KEY.ctrlC); await t.key(KEY.ctrlD); }
});

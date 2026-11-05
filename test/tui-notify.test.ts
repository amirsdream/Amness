import { test } from "node:test";
import assert from "node:assert/strict";
import { notifySequence, notifyVia } from "../cli/tui/notify.ts";
import { KeyParser } from "../cli/tui/keys.ts";
import { renderSidebar, type SidebarData } from "../cli/tui/sidebar.ts";
import { getTheme } from "../cli/tui/themes.ts";
import { call, KEY, rig, say } from "./helpers/apprig.ts";

test("notifyVia: the terminal's own notification where it is known to work, else the OS; AMNESS_NOTIFY=off silences it", () => {
  assert.equal(notifyVia({ TERM_PROGRAM: "iTerm.app" }, "darwin").kind, "osc9");
  assert.equal(notifyVia({ TERM_PROGRAM: "ghostty" }, "linux").kind, "osc9");
  assert.equal(notifyVia({ KITTY_WINDOW_ID: "1" }, "linux").kind, "osc99");
  assert.equal(notifyVia({ TERM: "foot" }, "linux").kind, "osc777");
  assert.equal(notifyVia({ TERM_PROGRAM: "Apple_Terminal" }, "darwin").kind, "os");
  assert.equal(notifyVia({ AMNESS_NOTIFY: "off", TERM_PROGRAM: "iTerm.app" }, "darwin").kind, "none");
});

test("notifySequence: control characters and separators in the text cannot break out of the sequence", () => {
  assert.equal(notifySequence({ kind: "osc9" }, "Amness", "done\x07;\x1b[2J"), "\x1b]9;Amness: done   [2J\x07");
  assert.equal(notifySequence({ kind: "osc777" }, "A", "b"), "\x1b]777;notify;A;b\x07");
  assert.equal(notifySequence({ kind: "os" }, "A", "b"), "");
});

test("keys: focus in and out are reported as their own events", () => {
  assert.deepEqual(new KeyParser().feed("\x1b[O\x1b[I"), [{ name: "focusout" }, { name: "focusin" }]);
});

test("approval while the terminal is in the background sends a notification; in the foreground it does not", async () => {
  for (const focus of ["\x1b[O", "\x1b[I"]) {
    const t = rig([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "two", new: "2" }), say("Edited.")]); await t.start();
    const sent: string[] = []; t.app.notifier = (title, body) => { sent.push(`${title}|${body}`); };
    await t.key(focus); await t.submit("change two to 2");
    assert.ok(await t.until(() => t.has("Apply this change?")));
    if (focus === "\x1b[O") { assert.equal(sent.length, 1); assert.match(sent[0], /^Amness needs your approval\|/); } else assert.equal(sent.length, 0);
    await t.key(KEY.enter); assert.ok(await t.until(() => t.idle())); await t.key(KEY.ctrlD);
  }
});

const base: SidebarData = { title: "t", model: "m", provider: "openai", cwd: "~/p", mode: "default", ctxPct: 10, ctxUsed: 100, ctxMax: 1000, series: [], map: [],
  usage: { prompt: 1000, completion: 100, calls: 2, cached: 0, reasoning: 0 }, cost: 0.12, todos: [], changes: [], tools: 5, mcp: 0, memory: 0, running: true, elapsedMs: 0 };
const text = (d: SidebarData) => renderSidebar(d, getTheme("dark"), 48, 60).rows.map((r) => r.map((c) => c.ch).join("")).join("\n");

test("sidebar: working subagents get their own panel with what each is doing; the last turn's cost shows when idle", () => {
  const s = text({ ...base, agents: [{ task: "find where tokens are refreshed", doing: "Reading src/auth.ts", steps: 4, secs: 12 }] });
  assert.match(s, /AGENTS\s+1 working/); assert.match(s, /find where tokens are refreshed/); assert.match(s, /Reading src\/auth\.ts · 4 steps · 12s/);
  assert.match(text({ ...base, running: false, lastTurnCost: 0.034 }), /last turn \$0\.03/);
  assert.doesNotMatch(text(base), /AGENTS/);
});

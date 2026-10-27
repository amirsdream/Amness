import { test } from "node:test";
import assert from "node:assert/strict";
import { call, say, rig, KEY, sleep } from "./helpers/apprig.ts";
import { cellWidth, strip } from "../cli/tui/text.ts";
import { renderDiffRows } from "../cli/tui/diffview.ts";
import { BlockStore } from "../cli/tui/blocks.ts";
import { getTheme } from "../cli/tui/themes.ts";

const files = { "src/app.ts": "export function f() {\n  return 1;\n}\n", "README.md": "# demo\n" };
const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n");
const mouse = (b: number, x: number, y: number, up = false) => `\x1b[<${b};${x};${y}${up ? "m" : "M"}`;

test("full: empty state, then a turn renders cards and the sidebar tracks changes", async () => {
  const t = rig([call("read_file", { path: "src/app.ts" }), call("edit_file", { path: "src/app.ts", old: "return 1", new: "return 2" }), say("done")], { cols: 132, rows: 40, files, ui: "full" });
  await t.start();
  assert.ok(t.has("reliable agents for any model") && t.has("Explain this repo"));
  await t.app.setMode("acceptEdits");
  await t.submit("change it");
  await t.until(() => t.idle() && t.has("done"));
  assert.ok(t.has("Update") && t.has("CHANGES"), t.screen());
  assert.ok(t.has("return 2"));
});

test("full: wheel scrolls, jump pill appears, ctrl+end returns", async () => {
  const t = rig([say(long)], { cols: 100, rows: 30, files, ui: "full" });
  await t.start(); await t.submit("go"); await t.until(() => t.idle());
  await t.type(mouse(64, 10, 10)); await t.type(mouse(64, 10, 10)); await t.settle();
  assert.ok(t.has("Jump to bottom"), t.screen());
  await t.type("\x1b[1;5F"); await t.settle();
  assert.ok(!t.screen().includes("Jump to bottom"));
});

test("full: ctrl+b hides the sidebar, ctrl+t cycles theme", async () => {
  const t = rig([], { cols: 132, rows: 30, files, ui: "full" });
  await t.start();
  assert.ok(t.screen().includes("SESSION"));
  await t.type("\x02"); await t.settle(); assert.ok(!t.screen().includes("SESSION"));
  const before = t.screen(); await t.type("\x14"); await t.settle(); assert.ok(t.screen() !== before);
});

test("full: diff renders exact widths in stacked and split modes", () => {
  const th = getTheme("aurora"), d = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-foo bar\n+foo baz\n";
  for (const width of [60, 130]) for (const mode of ["stacked", "split"] as const) {
    const { rows } = renderDiffRows(d, { width, theme: th, lang: "ts", mode });
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(cellWidth(strip(r)), width, `${mode}@${width}`);
  }
});

test("blocks: streaming assistant, tool lifecycle", () => {
  const s = new BlockStore();
  s.addUser("hi"); s.streamAssistant("hel"); s.streamAssistant("lo"); s.endAssistant();
  s.toolStart("c1", "read_file", JSON.stringify({ path: "a" }));
  s.toolEnd("c1", "x");
  assert.equal(s.blocks.length, 3);
  const a = s.blocks[1]; assert.ok(a.kind === "assistant" && a.text === "hello");
  assert.equal(s.blocks[2].kind === "tool" && s.blocks[2].status, "ok");
});

test("full: the run panel and status line follow the loop's phases", async () => {
  const t = rig([call("sh", { cmd: "sleep 1" }), say("ok")], { cols: 132, rows: 40, files, ui: "full" });
  await t.start(); t.app.setMode("yolo");
  await t.submit("go");
  assert.ok(await t.until(() => t.has("Running sleep 1") && t.has("RUN") && /step \d+\/\d+/.test(t.screen()), 3000), t.screen());
  assert.ok(t.has("think") && t.has("act") && t.has("verify"));
  await t.until(() => t.idle());
  assert.ok(!t.screen().includes("RUN"));
});

test("/loop shows a step-by-step trace of turns, tools and guards", async () => {
  const t = rig([call("read_file", { path: "src/app.ts" }), call("sh", { cmd: "echo hi" }), say("done")], { cols: 120, rows: 40, files, ui: "full" });
  await t.start(); t.app.setMode("yolo");
  await t.submit("go"); await t.until(() => t.idle());
  await t.submit("/loop"); await t.settle(200);
  const s = t.screen();
  assert.match(s, /Agent loop · 3 turns/); assert.ok(s.includes("model") && s.includes("Read") && s.includes("replied without tools"), s);
});

test("full: consecutive reads and searches collapse into one 'Explored' row that opens on click; edits and commands stay separate", async () => {
  const t = rig([call("list_files", {}), call("grep", { pattern: "f", path: "src" }), call("read_file", { path: "src/app.ts" }), call("edit_file", { path: "src/app.ts", old: "return 1", new: "return 2" }), call("sh", { cmd: "echo hi" }), say("done")], { cols: 132, rows: 40, files, ui: "full" });
  await t.start(); t.app.setMode("yolo");
  await t.submit("go"); await t.until(() => t.idle() && t.has("done"));
  assert.ok(t.has("Explored") && t.has("1 file read") && t.has("1 search") && t.has("3 steps"), t.screen());
  assert.ok(t.has("Update") && t.has("Bash"));
  const rows = t.screen().split("\n"), y = rows.findIndex((r) => r.includes("Explored")), x = rows[y].indexOf("Explored");
  await t.type(mouse(0, x + 1, y + 1)); await t.type(mouse(0, x + 1, y + 1, true)); await t.settle();
  assert.ok(t.has("src/app.ts") && /List\s+\./.test(t.screen()), t.screen());   // opened: one line per call
});

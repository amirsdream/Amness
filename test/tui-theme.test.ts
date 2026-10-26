import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../cli/tui/theme.ts";
import { cellWidth, strip } from "../cli/tui/text.ts";

test("detectLevel: NO_COLOR wins, FORCE_COLOR levels, COLORTERM truecolor, 256-colour TERM, piped = none", () => {
  assert.equal(T.detectLevel({ NO_COLOR: "1", FORCE_COLOR: "3" }, true), 0);
  assert.deepEqual(["0", "1", "2", "3"].map((f) => T.detectLevel({ FORCE_COLOR: f }, false)), [0, 1, 2, 3]);
  assert.equal(T.detectLevel({ COLORTERM: "truecolor" }, true), 3);
  assert.equal(T.detectLevel({ TERM_PROGRAM: "iTerm.app" }, true), 3);
  assert.equal(T.detectLevel({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, true), 2);
  assert.equal(T.detectLevel({ TERM: "xterm" }, true), 1);
  assert.equal(T.detectLevel({ TERM: "xterm-256color" }, false), 0);
});

test("fg emits truecolor, 256-colour or 16-colour sequences by level, and nothing at level 0", () => {
  const c: T.RGB = [255, 128, 0];
  T.setLevel(3); assert.equal(T.fg(c, "x"), "\x1b[38;2;255;128;0mx\x1b[39m");
  T.setLevel(2); assert.match(T.fg(c, "x"), /^\x1b\[38;5;\d+mx\x1b\[39m$/);
  T.setLevel(1); assert.match(T.fg(c, "x"), /^\x1b\[(3|9)\dmx\x1b\[39m$/);
  T.setLevel(0); assert.equal(T.fg(c, "x"), "x"); assert.equal(T.gradient("abc", T.palette.brand), "abc");
});

test("gradient colours every glyph along the stops, never changing the visible text", () => {
  T.setLevel(3);
  const g = T.gradient("hello world", T.palette.brand);
  assert.equal(strip(g), "hello world"); assert.ok((g.match(/\x1b\[38;2;/g) ?? []).length >= 10);
  assert.notEqual(g.slice(0, 40), g.slice(-60, -20));                                   // the colour really changes along the string
  assert.deepEqual(T.at(T.palette.brand, 0), T.palette.brand[0]); assert.deepEqual(T.at(T.palette.brand, 1), T.palette.brand[2]);
  T.setLevel(0);
});

test("gauge: width is constant, fill is proportional, low stays green and high turns red", () => {
  T.setLevel(3);
  for (const p of [0, 5, 50, 100, 140, -5]) assert.equal(cellWidth(T.gauge(p, 10)), 10);
  assert.equal(strip(T.gauge(30, 10)), "▰▰▰▱▱▱▱▱▱▱"); assert.equal(strip(T.gauge(100, 4)), "▰▰▰▰");
  const low = T.gauge(30, 10), high = T.gauge(100, 10);
  const colours = (s: string) => [...s.matchAll(/38;2;(\d+);(\d+);(\d+)/g)].map((m) => m.slice(1).map(Number));
  assert.ok(colours(low).every(([r, g]) => g > r), "low usage is green-dominant");
  const last = colours(high).at(-1)!; assert.ok(last[0] > 200 && last[1] < 130, "full gauge ends red");
  T.setLevel(1); assert.ok(T.gauge(90, 5).includes("\x1b[91m") || T.gauge(90, 5).includes("\x1b[31m"));       // basic terminals: whole bar goes red
  T.setLevel(0); assert.equal(T.gauge(50, 4), "▰▰▱▱");
});

test("sparkline scales to the max, keeps the last N, and handles empty/zero input", () => {
  T.setLevel(0);
  assert.equal(T.sparkline([1, 2, 4, 8], 10), "▂▃▅█"); assert.equal(T.sparkline([0, 0], 5), "▁▁"); assert.equal(T.sparkline([], 5), "");
  assert.equal(T.sparkline([5, 1, 2, 3, 4], 3), T.sparkline([2, 3, 4], 3));                  // only the last 3 values count
  assert.equal(strip(T.sparkline(Array.from({ length: 30 }, (_, i) => i), 8)).length, 8);
});

test("shimmer keeps the text intact and its highlight moves between frames", () => {
  T.setLevel(3);
  const a = T.shimmer("Working…", 0), b = T.shimmer("Working…", 6);
  assert.equal(strip(a), "Working…"); assert.notEqual(a, b);
  T.setLevel(1); assert.equal(strip(T.shimmer("Working…", 3)), "Working…");
  T.setLevel(0);
});

test("stackedBar: segments add up to exactly the width, legend lists non-empty parts with percentages", () => {
  T.setLevel(0);
  const r = T.stackedBar([{ label: "tools", value: 61, color: T.palette.read }, { label: "assistant", value: 22, color: T.palette.edit }, { label: "you", value: 9, color: T.palette.memory }, { label: "system", value: 8, color: T.palette.muted }, { label: "none", value: 0, color: T.palette.err }], 40);
  assert.equal(cellWidth(r.bar), 40); assert.deepEqual(r.legend, ["■ tools 61%", "■ assistant 22%", "■ you 9%", "■ system 8%"]);
  assert.equal(cellWidth(T.stackedBar([{ label: "a", value: 1, color: T.palette.ok }, { label: "b", value: 1, color: T.palette.ok }, { label: "c", value: 1, color: T.palette.ok }], 10).bar), 10);
});

test("brand + tool colours: Claude/OpenAI/local get their own identity; tools are coloured by what they do", () => {
  assert.deepEqual([T.brandOf("claude-opus-5-5").icon, T.brandOf("gpt-4.1").icon, T.brandOf("qwen2.5-coder:7b").icon, T.brandOf("mystery").icon], ["✻", "◈", "⬢", "◆"]);
  assert.equal(T.brandOf("whatever", "anthropic").icon, "✻");
  assert.deepEqual(T.toolColor("read_file"), T.palette.read); assert.deepEqual(T.toolColor("sh"), T.palette.shell); assert.deepEqual(T.toolColor("edit_file"), T.palette.edit);
  assert.deepEqual(T.toolColor("github__create_issue"), T.palette.web); assert.deepEqual(T.toolColor("totally_new"), T.palette.generic);
});

test("logo: three lines, the wordmark and version are present, widths are consistent, no colour leaks at level 0", () => {
  T.setLevel(0);
  const l = T.logo("1.2.3").map(strip);
  assert.equal(l.length, 3); assert.ok(l[0].includes("▄▀█ █▀▄▀█ █▄ █ █▀▀ █▀ █▀")); assert.ok(l[2].includes("v1.2.3"));
  assert.ok(l.every((x) => cellWidth(x) <= 70)); assert.equal(T.logo("1")[0].includes("\x1b"), false);
  T.setLevel(3); assert.ok(T.logo("1")[0].includes("\x1b[38;2;")); T.setLevel(0);
  assert.ok(T.TIPS.length >= 8 && T.TIPS.every((t) => t.length < 90));
});

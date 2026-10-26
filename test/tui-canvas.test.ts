import { test } from "node:test";
import assert from "node:assert/strict";
import { A, DEFAULT, cellsToAnsi, mix, parseAnsi, rgb, toRgb } from "../cli/tui/ansi.ts";
import { Canvas, quantize } from "../cli/tui/canvas.ts";
import { KeyParser } from "../cli/tui/keys.ts";
import { THEMES, contrast } from "../cli/tui/themes.ts";
import { VTerm } from "./helpers/vterm.ts";

test("parseAnsi: truecolor, 256, 16-colour, attributes, resets, wide and combining characters, OSC ignored", () => {
  const cells = parseAnsi("\x1b[38;2;255;128;0;48;5;17;1mA\x1b[0m\x1b[31;2mB\x1b[22;39m漢\x1b]0;title\x07é");
  assert.deepEqual([cells[0].ch, cells[0].fg, cells[0].bg, cells[0].attr], ["A", rgb(255, 128, 0), 0x1000000 + 17, A.bold]);
  assert.deepEqual([cells[1].fg, cells[1].attr], [0x1000000 + 1, A.dim]);
  assert.deepEqual([cells[2].ch, cells[2].w, cells[2].fg, cells[2].attr], ["漢", 2, DEFAULT, 0]);
  assert.deepEqual([cells.length, cells[3].ch], [4, "é"]);                                       // combining mark joined, OSC dropped
  assert.equal(parseAnsi("x", { bg: 0x112233 })[0].bg, 0x112233);                                      // base style is the starting point
});

test("cellsToAnsi round-trips through parseAnsi", () => {
  const src = "\x1b[1;38;2;1;2;3mhi \x1b[0m\x1b[48;2;9;9;9mthere\x1b[0m";
  const again = parseAnsi(cellsToAnsi(parseAnsi(src)));
  assert.deepEqual(again.map((c) => [c.ch, c.fg, c.bg, c.attr]), parseAnsi(src).map((c) => [c.ch, c.fg, c.bg, c.attr]));
});

test("colour helpers: palette resolution, mixing, and quantisation to 256/16 colours", () => {
  assert.equal(toRgb(0x1000000 + 196, 0), 0xff0000); assert.equal(toRgb(0x1000000 + 232, 0), 0x080808); assert.equal(toRgb(DEFAULT, 0x123456), 0x123456);
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080);
  assert.equal(quantize(0x336699, 3), 0x336699); assert.equal(quantize(0x336699, 0), DEFAULT);
  const q2 = quantize(0xff0000, 2); assert.ok(q2 >= 0x1000000 && q2 - 0x1000000 === 196);
  assert.ok(quantize(0x808080, 2) - 0x1000000 >= 232);                                                  // greys use the grey ramp
  assert.equal(quantize(0xff3030, 1), 0x1000000 + 9); assert.equal(quantize(0x101010, 1, true), 0x1000000 + 0);
});

test("Canvas drawing: text clipping, wide chars, boxes with titles, fill, tint, dim", () => {
  const c = new Canvas(20, 6, 0x101010);
  c.text(0, 0, "hello world", { fg: 0xffffff }, 5);
  assert.equal(c.readRow(0), "hello");                                                                 // clipped to maxW
  c.text(0, 1, "漢字x", {}); assert.deepEqual([c.ch[20], c.ch[21], c.ch[22], c.ch[23], c.ch[24]], ["漢", "", "字", "", "x"]);
  c.box(0, 2, 10, 4, { border: 0x888888, bg: 0x202020, title: "Box" });
  assert.equal(c.readRow(2, 0, 10), "╭─ Box ──╮"); assert.equal(c.readRow(5, 0, 10), "╰────────╯"); assert.equal(c.bg[3 * 20 + 3], 0x202020);
  c.tint(1, 3, 3, 1, 0x445566); assert.equal(c.bg[3 * 20 + 2], 0x445566);
  const before = c.fg[0]; c.dim(0, 0, 5, 1, 0.5, 0x000000, 0xffffff, 0x101010); assert.notEqual(c.fg[0], before);
});

test("flush emits only what changed, nothing when nothing changed, and a full repaint on request", () => {
  const c = new Canvas(30, 8, 0x0d1017);
  c.text(2, 1, "static", { fg: 0xdddddd }); c.text(2, 3, "counter 0", { fg: 0x88ccff });
  const first = c.flush(); assert.ok(first.includes("static") && first.includes("counter 0"));
  assert.equal(c.flush(), "");                                                                           // identical frame: zero bytes
  c.text(10, 3, "7", { fg: 0x88ccff });
  const delta = c.flush(); assert.ok(delta.includes("7") && !delta.includes("static") && delta.length < 80, JSON.stringify(delta));
  assert.ok(c.flush(true).includes("static"));                                                           // forced repaint
  c.invalidate(); assert.ok(c.flush().includes("counter"));
});

test("REPLAY PROOF: applying every flush to a terminal reproduces the canvas exactly, across many random frames (incl. wide chars, overdraw, dim)", () => {
  const W = 40, H = 14, canvas = new Canvas(W, H, 0x0d1017), term = new VTerm(W, H);
  let seed = 12345; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ["alpha", "漢字テスト", "░▒▓", "▰▰▱▱", "x", "✻ work", "┃│", "emoji🙂ok", "pad  "];
  const compare = (label: string) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, got = term.cells()[y][x];
      if (canvas.ch[i] === "") continue;                                                                 // second half of a wide glyph
      assert.equal(got.ch === "" ? " " : got.ch, canvas.ch[i], `${label} ch @${x},${y}`);
      assert.equal(toRgb(got.bg, 0x000001), toRgb(canvas.bg[i], 0x000001), `${label} bg @${x},${y}`);
      if (canvas.ch[i].trim()) assert.equal(toRgb(got.fg, 0x000002), toRgb(canvas.fg[i], 0x000002), `${label} fg @${x},${y}`);
      if (canvas.ch[i].trim()) assert.equal(got.attr, canvas.attr[i], `${label} attr @${x},${y}`);
    }
  };
  term.write(canvas.flush(true).replace(/^/, "\x1b[2J"));
  for (let frame = 0; frame < 60; frame++) {
    for (let k = 0; k < 1 + rnd(5); k++) {
      const op = rnd(5), x = rnd(W - 4), y = rnd(H), color = rnd(0xffffff), bgc = rnd(0xffffff);
      if (op === 0) canvas.text(x, y, words[rnd(words.length)], { fg: color, bg: rnd(2) ? bgc : undefined, attr: rnd(3) === 0 ? A.bold : 0 }, 3 + rnd(12));
      else if (op === 1) canvas.fill(x, y, 1 + rnd(8), 1 + rnd(3), bgc);
      else if (op === 2) canvas.box(x, y, 4 + rnd(10), 3 + rnd(3), { border: color, bg: bgc, title: rnd(2) ? "t" : undefined });
      else if (op === 3) canvas.dim(x, y, 1 + rnd(10), 1 + rnd(4), 0.5, 0x000000, 0xdddddd, 0x0d1017);
      else canvas.tint(x, y, 1 + rnd(10), 1, bgc);
    }
    term.write(canvas.flush()); compare(`frame ${frame}`);
  }
});

test("mouse: SGR reports decode to press/release/drag/wheel with 0-based coordinates and modifiers", () => {
  const ev = (s: string) => new KeyParser().feed(s)[0].mouse!;
  assert.deepEqual(ev("\x1b[<0;10;5M"), { x: 9, y: 4, button: "left", action: "press" });
  assert.deepEqual(ev("\x1b[<0;10;5m"), { x: 9, y: 4, button: "left", action: "release" });
  assert.deepEqual(ev("\x1b[<32;12;5M"), { x: 11, y: 4, button: "left", action: "drag" });
  assert.deepEqual(ev("\x1b[<2;1;1M"), { x: 0, y: 0, button: "right", action: "press" });
  assert.equal(ev("\x1b[<64;3;3M").action, "wheelup"); assert.equal(ev("\x1b[<65;3;3M").action, "wheeldown");
  assert.deepEqual([ev("\x1b[<4;1;1M").shift, ev("\x1b[<8;1;1M").alt, ev("\x1b[<16;1;1M").ctrl], [true, true, true]);
  const p = new KeyParser(); assert.deepEqual(p.feed("\x1b[<0;10"), []); assert.equal(p.feed(";5M")[0].mouse!.x, 9);   // split across reads
  assert.deepEqual(p.feed("a\x1b[<0;1;1Mb").map((k) => k.name), ["char", "mouse", "char"]);                          // interleaved with typing
});

test("every theme is readable: body text, dim text, accents, diff colours and syntax colours meet contrast targets", () => {
  for (const t of Object.values(THEMES)) {
    if (t.name === "terminal") continue;
    const c = (a: number, b: number, min: number, what: string) => assert.ok(contrast(a, b) >= min, `${t.name}: ${what} contrast ${contrast(a, b).toFixed(2)} < ${min}`);
    c(t.text, t.bg, 7, "text/bg"); c(t.text, t.surface2, 7, "text/surface2"); c(t.dim, t.bg, 4.5, "dim/bg"); c(t.dim, t.surface, 4.5, "dim/surface"); c(t.faint, t.bg, 3, "faint/bg");
    c(t.onAccent, t.accent, 4.5, "onAccent/accent");
    for (const k of ["ok", "warn", "err", "info", "accent", "accent2"] as const) c(t[k], t.bg, 4.5, k);
    c(t.addFg, t.addBg, 4.5, "add"); c(t.delFg, t.delBg, 4.5, "del");
    for (const [k, v] of Object.entries(t.syn)) c(v, t.surface, k === "comment" ? 3 : 4.5, `syntax ${k}`);
    assert.ok(t.gradient.length >= 3);
  }
});

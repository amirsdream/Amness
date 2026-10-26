import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex, applySuggestion, fuzzyScore, rankCommands, rankFiles, tokenAtCursor } from "../cli/tui/complete.ts";
import { cellWidth, strip } from "../cli/tui/text.ts";

process.env.FORCE_COLOR = "1"; delete process.env.NO_COLOR;          // the renderer's colours are part of what we assert; must be set before ui.ts loads
const { highlight, inline, renderMarkdown, takeCompleteBlocks } = await import("../cli/tui/markdown.ts");

const plain = (lines: string[]) => lines.map(strip);

test("complete: token detection for slash commands and @files", () => {
  assert.deepEqual(tokenAtCursor("/mo", 3), { kind: "slash", query: "mo", start: 0, end: 3 });
  assert.equal(tokenAtCursor("/model gpt", 10), null);                          // already past the command word
  assert.equal(tokenAtCursor("hello /x", 8), null);                             // slash only counts at the start
  assert.deepEqual(tokenAtCursor("look at @src/ma", 15), { kind: "file", query: "src/ma", start: 8, end: 15 });
  assert.deepEqual(tokenAtCursor("@", 1), { kind: "file", query: "", start: 0, end: 1 });
  assert.equal(tokenAtCursor("mail me@example.com", 19), null);                // an @ inside a word is not a mention
});

test("complete: commands rank prefix before substring; files rank basename/segment hits first", () => {
  const cmds = [{ name: "model", help: "m" }, { name: "memory", help: "mm" }, { name: "compact", help: "c" }, { name: "clear", help: "x" }];
  assert.deepEqual(rankCommands("m", cmds).map((s) => s.label), ["/memory", "/model", "/compact"]);
  assert.deepEqual(rankCommands("", cmds).length, 4);
  const aliased = [{ name: "tokens", help: "usage", alias: "cost" }, { name: "compact", help: "c" }];
  assert.deepEqual(rankCommands("cost", aliased).map((s) => [s.label, s.detail]), [["/tokens", "usage (also /cost)"]]);        // typing an alias finds the real command
  assert.equal(rankCommands("tok", aliased)[0].detail, "usage");
  const files = ["src/harness.ts", "src/code.ts", "test/code.test.ts", "README.md", "cli/amness.ts", "docs/hardness-notes.md"];
  assert.equal(rankFiles("code", files)[0].label, "src/code.ts");
  assert.equal(rankFiles("readme", files)[0].label, "README.md");
  assert.equal(rankFiles("amn", files)[0].label, "cli/amness.ts");
  assert.equal(rankFiles("zzz", files).length, 0);
  assert.ok(fuzzyScore("sch", "src/schema.ts")! > fuzzyScore("sch", "src/some-long-chunk-here.ts")!);
});

test("complete: applying a suggestion replaces just the token and positions the cursor", () => {
  const t = tokenAtCursor("fix @src/ha please", 11)!;
  const r = applySuggestion("fix @src/ha please", t, { label: "src/harness.ts", insert: "@src/harness.ts " });
  assert.equal(r.text, "fix @src/harness.ts  please"); assert.equal(r.cursor, 4 + "@src/harness.ts ".length);
});

test("FileIndex: walks a directory (skipping node_modules/.git/dotdirs) when git is unavailable", async () => {
  const d = mkdtempSync(join(tmpdir(), "amness-fi-"));
  for (const f of ["a.ts", "src/b.ts", "node_modules/x/y.js", ".git/config", ".hidden/z", "docs/readme.md"]) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), ""); }
  const idx = new FileIndex(d); await idx.ensure(0);
  assert.deepEqual([...idx.files].sort(), ["a.ts", "docs/readme.md", "src/b.ts"]);
});

test("markdown: headings, lists, quotes, rules, inline styles, links", () => {
  const md = "# Title\n\nSome **bold**, *it*, `code` and [a link](https://x.io).\n\n- one\n- two\n  - nested\n1. first\n\n> quoted\n\n---";
  const out = plain(renderMarkdown(md, 60)).join("\n");
  assert.match(out, /Title\n─+/); assert.match(out, /Some bold, it, code and a link \(https:\/\/x\.io\)\./);
  assert.match(out, /• one\n• two\n  ◦ nested\n1\. first/); assert.match(out, /▎ quoted/); assert.match(out, /─{10,}$/);
  assert.ok(renderMarkdown("**b** `c`", 40)[0].includes("\x1b[1mb"), "bold is actually styled");
});

test("markdown: code fences keep content verbatim (no inline formatting inside), label the language, wrap long lines", () => {
  const out = plain(renderMarkdown("Text\n\n```ts\nconst a = **not bold** + `x`;\n```\n\nafter", 40));
  assert.deepEqual(out.slice(0, 2), ["Text", ""]); assert.ok(out.includes("  ╭─ ts"));
  assert.ok(out.includes("  │ const a = **not bold** + `x`;")); assert.equal(out.at(-1), "after");
  const long = plain(renderMarkdown("```\n" + "x".repeat(100) + "\n```", 30));
  assert.ok(long.every((l) => cellWidth(l) <= 30) && long.filter((l) => !l.includes("╰─")).join("").replace(/[ │]/g, "").length === 100);
  assert.equal(long.at(-1), "  ╰─");                                                 // the block is closed
  const diff = renderMarkdown("```diff\n+added\n-removed\n```", 40).join("\n");
  assert.ok(diff.includes("\x1b[32m+added") && diff.includes("\x1b[31m-removed"));
});

test("markdown: tables render aligned with borders; too-wide tables degrade gracefully", () => {
  const md = "| name | n |\n|------|---|\n| alpha | 1 |\n| b | 22 |";
  const out = plain(renderMarkdown(md, 60));
  assert.equal(out[0], "┌───────┬────┐"); assert.equal(out[1], "│ name  │ n  │"); assert.equal(out[3], "│ alpha │ 1  │"); assert.equal(out.at(-1), "└───────┴────┘");
  assert.ok(new Set(out.map(cellWidth)).size === 1);
  const narrow = plain(renderMarkdown(md, 10)); assert.ok(narrow[0].includes("name | n"));
});

test("markdown: every rendered row fits the width (wrapping lists, quotes, paragraphs)", () => {
  const md = "A very long paragraph with `inline code` and **bold text** that definitely has to wrap around.\n\n- a long list item that also needs wrapping to the next line nicely\n\n> a long quote that is wrapped too, because narrow terminals exist";
  for (const w of [20, 33, 80]) assert.ok(renderMarkdown(md, w).every((l) => cellWidth(l) <= w), `width ${w}`);
});

test("highlight: keywords/strings/numbers/comments are styled per language; unknown languages stay readable", () => {
  const js = highlight('const x = "hi"; // note 42', "ts");
  assert.ok(js.includes("\x1b[35mconst") && js.includes('\x1b[32m"hi"') && js.includes("\x1b[90m// note 42"));
  assert.ok(highlight("def f(): # c", "python").includes("\x1b[35mdef") && highlight("x = 1 # c", "py").includes("\x1b[90m# c"));
  assert.equal(strip(highlight("whatever 12 here", "klingon")), "whatever 12 here");
  assert.equal(strip(inline("snake_case_name and 2*3*4")), "snake_case_name and 2*3*4");            // no accidental italics
});

test("takeCompleteBlocks: only whole paragraphs are released while streaming; open code fences are held back", () => {
  assert.deepEqual(takeCompleteBlocks("para one\n\npara tw"), { done: "para one", rest: "para tw" });
  assert.deepEqual(takeCompleteBlocks("still typing"), { done: "", rest: "still typing" });
  const fenced = "intro\n\n```js\nlet a = 1;\n\nlet b = 2;";
  assert.deepEqual(takeCompleteBlocks(fenced), { done: "intro", rest: "```js\nlet a = 1;\n\nlet b = 2;" });
  const closed = fenced + "\n```\n\nnext";
  assert.equal(takeCompleteBlocks(closed).rest, "next"); assert.ok(takeCompleteBlocks(closed).done.endsWith("```"));
  const all = ["a\n\nb\n\nc", "x"]; assert.equal(takeCompleteBlocks(all[0]).done + "|" + takeCompleteBlocks(all[0]).rest, "a\n\nb|c");
});

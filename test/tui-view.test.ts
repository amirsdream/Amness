import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unifiedDiff } from "../src/index.ts";
import { SessionStore, newSession, rewind, snapshot } from "../cli/tui/session.ts";
import { cellWidth, strip } from "../cli/tui/text.ts";

process.env.FORCE_COLOR = "1"; delete process.env.NO_COLOR;
const v = await import("../cli/tui/view.ts");
const P = (l: string[]) => l.map(strip);

test("view: tool headers use friendly names and argument summaries", () => {
  assert.equal(strip(v.toolHeader("sh", '{"cmd":"npm test"}')), "● Bash(npm test)");
  assert.equal(strip(v.toolHeader("read_file", '{"path":"src/a.ts","start":10,"end":20}')), "● Read(src/a.ts:10-20)");
  assert.equal(strip(v.toolHeader("grep", '{"pattern":"foo","path":"src"}')), '● Search("foo" in src)');
  assert.equal(strip(v.toolHeader("task", '{"description":"find all callers of x"}', true, "explore")), "  │ ● Explore(find all callers of x)");
  assert.equal(strip(v.toolHeader("custom_thing", "{bad json", false)), "● custom_thing({bad json)");
  assert.equal(strip(v.toolHeader("mcp__echo", '{"text":"yo"}')), "● mcp__echo(yo)");
  assert.equal(strip(v.toolHeader("mcp__q", '{"a":1,"b":"x"}')), "● mcp__q(a=1, b=x)");
  assert.ok(v.toolHeader("sh", "{}", false).includes("\x1b[31m●"));                    // failures get a red bullet
});

test("view: result blocks summarise instead of dumping", () => {
  const read = P(v.toolResult("read_file", "{}", Array.from({ length: 120 }, (_, i) => `${i + 1}\tx`).join("\n"), 80));
  assert.deepEqual(read, ["  ⎿  Read 120 lines"]);
  assert.deepEqual(P(v.toolResult("grep", "{}", "a.ts:1:x\na.ts:5:y\nb.ts:2:z\n", 80)), ["  ⎿  3 matches in 2 files"]);
  assert.deepEqual(P(v.toolResult("grep", "{}", "a.ts:1:x\n", 80)), ["  ⎿  1 match in 1 file"]);
  assert.deepEqual(P(v.toolResult("grep", "{}", "no matches", 80)), ["  ⎿  No matches"]);
  const sh = P(v.toolResult("sh", "{}", "exit=0\n" + Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n"), 80));
  assert.equal(sh.length, 9); assert.match(sh.at(-1)!, /… \+12 more lines \(ctrl\+o to view all\)/); assert.equal(sh[0], "  ⎿  out 0");
  assert.deepEqual(P(v.toolResult("sh", "{}", "exit=0\n", 80)), ["  ⎿  (no output)"]);
  const fail = P(v.toolResult("sh", "{}", "exit=1\nboom\nstack", 80)); assert.ok(fail[0].includes("exit=1"));
  assert.equal(v.isFailure("ERROR: nope"), true); assert.equal(v.isFailure("exit=0\nok"), false); assert.equal(v.isFailure("exit=2\n"), true);
  assert.deepEqual(v.toolResult("write_file", "{}", "wrote 3 chars", 80), []);        // edits show their diff instead
});

test("view: diff gets line numbers, +/- colours, hunk gaps and truncation", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 3\n", "LINE 3\nextra\n").replace("line 25\n", "");
  const rows = v.renderDiff(unifiedDiff("f.txt", before, after).diff, 60);
  const text = P(rows);
  assert.ok(text.some((l) => /\s3 - line 3$/.test(l))); assert.ok(text.some((l) => /\s3 \+ LINE 3$/.test(l))); assert.ok(text.some((l) => /\s4 \+ extra$/.test(l)));
  assert.ok(text.some((l) => l.includes("⋮")));                                       // gap between the two hunks
  assert.ok(rows.some((l) => l.includes("\x1b[32m")) && rows.some((l) => l.includes("\x1b[31m")));
  assert.ok(text.every((l) => cellWidth(l) <= 60));
  const big = v.renderDiff(unifiedDiff("g", "", Array.from({ length: 100 }, (_, i) => `n${i}`).join("\n")).diff, 60, 10);
  assert.equal(big.length, 11); assert.match(strip(big.at(-1)!), /… \+\d+ more lines/);
  assert.equal(v.editSummary({ created: false, added: 1, removed: 2 }), "Added 1 line, removed 2 lines"); assert.equal(v.editSummary({ created: true, added: 4, removed: 0 }), "Created with 4 lines");
});

test("view: user and assistant messages: markers, wrapping, block spacing", () => {
  assert.deepEqual(P(v.userMessage("hello\nworld", 40)), ["", "❯ hello", "  world"]);
  assert.ok(P(v.userMessage("x".repeat(100), 30)).every((l) => cellWidth(l) <= 30));
  assert.deepEqual(P(v.assistantBlock("First para", 40, true)), ["● First para"]);
  assert.deepEqual(P(v.assistantBlock("Second para", 40, false)), ["", "  Second para"]);
  assert.ok(P(v.assistantBlock("# Head\n\n- a\n- b", 40, true)).join("\n").includes("• a"));
  assert.deepEqual(v.assistantBlock("", 40, true), []);
});

test("view: todos, option lists, framed boxes, footer, help, welcome", () => {
  const todos = P(v.todoList([{ content: "write tests", status: "done" }, { content: "fix bug", status: "in_progress" }, { content: "ship", status: "pending" }], 60));
  assert.deepEqual(todos, ["  ☰ Todos 1/3", "    ☒ write tests", "    ▶ fix bug", "    ☐ ship"]);
  assert.deepEqual(P(v.optionList([{ label: "Yes" }, { label: "No", hint: "esc" }], 1)), ["  1. Yes", "❯ 2. No  esc"]);
  const box = P(v.framed("Edit file", ["src/a.ts", "a long line ".repeat(10)], 40));
  assert.ok(box.every((l) => cellWidth(l) === 40), JSON.stringify(box.map(cellWidth)));
  assert.match(box[0], /^╭─ Edit file ─+╮$/); assert.match(box.at(-1)!, /^╰─+╯$/);
  const f = strip(v.footer({ mode: "acceptEdits", model: "claude-opus-5-5", ctxPct: 12, cost: "$0.42", branch: "main", queued: 2 }, 100));
  assert.ok(f.includes("accept edits on") && f.includes("✻ claude-opus-5-5") && /▰+▱+ 12%/.test(f) && f.includes("$0.42") && f.includes("2 queued") && cellWidth(f) <= 100);
  assert.ok(strip(v.footer({ mode: "default", model: "gpt-4.1", provider: "openai", ctxPct: null, cost: "" }, 80)).includes("◈ gpt-4.1"));
  assert.ok(strip(v.footer({ mode: "default", model: "m", ctxPct: null, cost: "" }, 60)).includes("? for shortcuts"));
  assert.ok(P(v.helpLines([{ name: "model", help: "switch model" }], 80)).join("\n").match(/\/model\s+switch model/));
  const w = P(v.welcome({ version: "0.1", model: "m", cwd: "/x/y", notes: 2, mode: "default", verify: "npm test" }, 80)).join("\n");
  assert.ok(w.includes("2 notes loaded") && w.includes("npm test") && w.includes("/help"));
  assert.ok(w.includes("▄▀█ █▀▄▀█") && w.includes("v0.1") && w.includes("reliable agents") && w.includes("◆ m"), "logo and model identity are on the welcome card");
  assert.match(P(v.welcome({ version: "1", model: "claude-opus-5-5", provider: "anthropic", cwd: "/x", notes: 0, mode: "default", tip: "Try /plan" }, 80)).join("\n"), /✻ claude-opus-5-5[\s\S]*tip Try \/plan/);
});

test("session: save/list/load round-trips, newest first, empty sessions hidden", () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-ss-")), st = new SessionStore(dir);
  const a = newSession(dir, "m"); a.title = "first"; a.turns.push({ at: 2, text: "hi", t: 1, snaps: {} }); st.save(a);
  const b = newSession(dir, "m"); st.save(b);                                           // no turns -> not listed
  assert.deepEqual(st.list().map((s) => s.title), ["first"]);
  const c = newSession(dir, "m"); c.title = "second"; c.turns.push({ at: 2, text: "x", t: 1, snaps: {} }); c.updated = "2999-01-01T00:00:00.000Z"; writeFileSync(join(st.dir, c.id + ".json"), JSON.stringify(c));
  assert.deepEqual(st.list().map((s) => s.title), ["second", "first"]); assert.equal(st.latest()!.title, "second"); assert.equal(st.load(a.id)!.turns[0].text, "hi");
  st.remove(a.id); assert.equal(st.load(a.id), undefined);
});

test("rewind: restores edited files (earliest snapshot wins), deletes files the turns created, truncates the conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-rw-"));
  writeFileSync(join(dir, "a.txt"), "v3"); writeFileSync(join(dir, "new.txt"), "created later"); mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "sub/b.txt"), "b2");
  const s = newSession(dir, "m");
  s.messages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) }) as any);
  s.turns = [{ at: 0, text: "t0", t: 0, snaps: {} }, { at: 4, text: "t1", t: 0, snaps: {} }, { at: 8, text: "t2", t: 0, snaps: {} }];
  snapshot(s.turns[1], "a.txt", "v1"); snapshot(s.turns[1], "a.txt", "SHOULD-BE-IGNORED"); snapshot(s.turns[1], "new.txt", null);
  snapshot(s.turns[2], "a.txt", "v2"); snapshot(s.turns[2], "sub/b.txt", "b1"); snapshot(s.turns[2], "../escape.txt", "x");
  const r = rewind(s, dir, 1);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "v1");                         // turn 1's snapshot, not turn 2's
  assert.equal(readFileSync(join(dir, "sub/b.txt"), "utf8"), "b1"); assert.equal(existsSync(join(dir, "new.txt")), false);
  assert.deepEqual([r.restored.sort(), r.removed, r.skipped], [["a.txt", "sub/b.txt"], ["new.txt"], ["../escape.txt"]]);
  assert.equal(s.messages.length, 4); assert.equal(s.turns.length, 1);
  assert.deepEqual(rewind(s, dir, 5), { restored: [], removed: [], skipped: [] });
});

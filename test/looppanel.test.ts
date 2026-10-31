import assert from "node:assert/strict";
import { test } from "node:test";
import { capNote, isIntervention, litStages, renderLoop, roundOf, stageOfTool, stagesOf, stepMs, stepSummary, type LoopData, type LoopStep } from "../cli/tui/looppanel.ts";
import { getTheme } from "../cli/tui/themes.ts";
import { strip } from "../cli/tui/text.ts";
import { mix } from "../cli/tui/ansi.ts";

const t = getTheme("dark"), W = 32;
const tool = (name: string, ok = true, ms = 400, args: object = { path: "a.ts" }) => ({ name, args: JSON.stringify(args), ms, ok });
const sh = (cmd: string, ok = true) => tool("sh", ok, 500, { cmd });
const step = (n: number, tools: ReturnType<typeof tool>[], notes: string[] = [], extra: Partial<LoopStep> = {}): LoopStep => ({ n, t0: 1000 * n, ms: 1200, tools, notes, ...extra });
const data = (steps: LoopStep[], over: Partial<LoopData> = {}): LoopData => ({ live: true, phase: "model", cap: 60, now: 1000 * (steps.length + 1) + 1800, frame: 0, elapsedMs: 41_000, steps, inflight: [], open: [], ...over });
const text = (d: LoopData, rows = 14, inner = W) => { const r = renderLoop(d, t, inner, rows); return { ...r, plain: r.lines.map((l) => strip(l)), raw: r.lines }; };

test("stages are inferred from the tool, and for shell commands from the command line", () => {
  assert.equal(stageOfTool("read_file"), "gather"); assert.equal(stageOfTool("grep"), "gather"); assert.equal(stageOfTool("web_search"), "gather");
  assert.equal(stageOfTool("edit_file"), "act"); assert.equal(stageOfTool("write_file"), "act"); assert.equal(stageOfTool("apply_patch"), "act");
  assert.equal(stageOfTool("sh", JSON.stringify({ cmd: "npm test" })), "verify");
  for (const c of ["pytest -x", "tsc --noEmit", "cargo test", "go vet ./...", "npm run build", "node --test test/a.test.ts", "eslint src", "make check"]) assert.equal(stageOfTool("sh", JSON.stringify({ cmd: c })), "verify", c);
  for (const c of ["ls -la", "cat src/a.ts", "git diff", "grep -rn foo .", "git status"]) assert.equal(stageOfTool("sh", JSON.stringify({ cmd: c })), "gather", c);
  for (const c of ["mkdir out", "rm -f tmp", "node script.js", "git commit -m x", "sed -i s/a/b/ f"]) assert.equal(stageOfTool("sh", JSON.stringify({ cmd: c })), "act", c);
  assert.equal(stageOfTool("todo_write"), undefined); assert.equal(stageOfTool("finish"), undefined);       // bookkeeping is outside the cycle
  assert.deepEqual(stagesOf([tool("edit_file"), tool("read_file"), sh("npm test")]), ["gather", "act", "verify"]);   // in cycle order
});

test("a round is one trip round the cycle: a new one starts when the agent gathers or acts again after verifying", () => {
  assert.equal(roundOf([]), 1);
  assert.equal(roundOf([step(1, [tool("read_file")]), step(2, [tool("edit_file")]), step(3, [sh("npm test")])]), 1);
  assert.equal(roundOf([step(1, [tool("read_file")]), step(2, [tool("edit_file")]), step(3, [sh("npm test", false)]), step(4, [tool("edit_file")]), step(5, [sh("npm test")])]), 2);   // fix after a failed test
  assert.equal(roundOf([step(1, [sh("npm test")]), step(2, [sh("npm run lint")])]), 1);           // verifying twice in a row is still one round
  assert.equal(roundOf([step(1, [sh("npm test")]), step(2, [tool("grep")]), step(3, [tool("edit_file")]), step(4, [sh("npm test")]), step(5, [tool("read_file")])]), 3);
});

test("what is lit: running tools light their stage; while the model thinks, the last stage used is shown dimmed", () => {
  const steps = [step(1, [tool("read_file")]), step(2, [])];
  assert.deepEqual([...litStages(data(steps, { phase: "model" })).now], []);
  assert.deepEqual([...litStages(data(steps, { phase: "model" })).recent], ["gather"]);
  const editing = litStages(data(steps, { phase: "tools", inflight: [{ label: "Updating a.ts", ms: 10, name: "edit_file", args: "{}" }] }));
  assert.deepEqual([...editing.now], ["act"]); assert.equal(editing.recent.size, 0);
  const mixed = litStages(data(steps, { phase: "tools", inflight: [{ label: "x", ms: 1, name: "read_file", args: "{}" }, { label: "y", ms: 1, name: "edit_file", args: "{}" }] }));
  assert.deepEqual([...mixed.now].sort(), ["act", "gather"]);                                 // parallel tools of two stages: both light
  assert.deepEqual([...litStages(data(steps, { phase: "verify" })).now], ["verify"]);         // the verify gate at finish
  assert.equal(litStages(data(steps, { live: false })).now.size, 0);                           // a finished run lights nothing
});

const BOLD_ON = "\x1b[1m", rgb = (c: number) => `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`;
const parts = (line: string) => line.split(" ▸ ");        // gather | act | verify (the arrows are plain separators)

test("the cycle line names the three stages and lights only the one that is running", () => {
  const editing = text(data([step(1, [tool("read_file")]), step(2, [])], { phase: "tools", inflight: [{ label: "Updating a.ts", ms: 900, name: "edit_file", args: "{}" }] }));
  assert.equal(editing.plain[0], "◉ gather ▸ ✎ act ▸ ✓ verify");
  const [g, a, v] = parts(editing.raw[0]);
  assert.ok(!g.includes(BOLD_ON) && a.includes(BOLD_ON) && !v.includes(BOLD_ON), "only act is bold");
  assert.ok(a.includes(rgb(t.tool.edit)), "act uses the edit colour");
  const verifying = text(data([step(1, [])], { phase: "verify" })), [g2, , v2] = parts(verifying.raw[0]);
  assert.ok(v2.includes(BOLD_ON) && v2.includes(rgb(t.ok)) && !g2.includes(BOLD_ON), "verify lights green at the verify gate");
  const idle = text(data([step(1, [])], { phase: "model" }));
  assert.ok(!idle.raw[0].includes(BOLD_ON), "nothing is bold while the model thinks and nothing has run");
  assert.match(editing.plain[1], /Updating a\.ts/);                                           // and the line below says what is running
  assert.equal(text(data([step(1, [])]), 14, 22).plain[0], "◉ ▸ ✎ ▸ ✓");                       // too narrow for labels: icons only
});

test("while the model thinks, the stage just used stays visible but dimmer than a lit one", () => {
  const r = text(data([step(1, [tool("read_file")]), step(2, [])], { phase: "model" })), [g, a] = parts(r.raw[0]);
  assert.ok(!g.includes(BOLD_ON) && g.includes("\x1b[38;2;"), "gather is coloured, not bold");
  assert.ok(!g.includes(rgb(t.faint)) && a.includes(rgb(t.faint)), "gather is coloured (recent) while act is the plain dim colour");
});

test("a failed verify keeps the verify icon red until a later one passes", () => {
  const steps = (...tools: ReturnType<typeof sh>[][]) => tools.map((ts, i) => step(i + 1, ts));
  const failed = text(data(steps([tool("edit_file")], [sh("npm test", false)]), { phase: "model" }));
  const passed = text(data(steps([tool("edit_file")], [sh("npm test", false)], [tool("edit_file")], [sh("npm test", true)]), { phase: "model" }));
  const redish = rgb(mix(t.err, t.surface, 0.35));
  assert.ok(parts(failed.raw[0])[2].includes(redish), "verify is red after a failed test");
  assert.ok(!parts(passed.raw[0])[2].includes(redish), "and not red once a later test passed");
  const verifying = text(data(steps([tool("edit_file")], [sh("npm test", false)]), { phase: "verify" }));
  assert.ok(parts(verifying.raw[0])[2].includes(rgb(t.err)) && parts(verifying.raw[0])[2].includes(BOLD_ON), "running again while still failing: bright red");
});

test("the header shows the round and the step; the step limit stays out of sight early", () => {
  const early = text(data([step(1, [tool("read_file")]), step(2, [tool("edit_file")]), step(3, [sh("npm test", false)]), step(4, [])]));
  assert.equal(early.right.replace(/\x1b\[[0-9;]*m/g, ""), "round 1 · step 4");
  assert.ok(!/60/.test(early.plain.join("\n")) && !/▰/.test(early.plain.join("\n")));
  const second = text(data([step(1, [sh("npm test", false)]), step(2, [tool("edit_file")]), step(3, [])]));
  assert.match(second.right.replace(/\x1b\[[0-9;]*m/g, ""), /round 2 · step 3/);
  assert.equal(capNote(31, 60).level, "dim"); assert.equal(capNote(48, 60).level, "warn");
  const late = text(data(Array.from({ length: 50 }, (_, i) => step(i + 1, [tool("grep")]))));
  assert.match(late.plain.join("\n"), /50\/60: close to the step limit/); assert.match(late.plain.join("\n"), /▰/);
});

test("the activity line says what the loop is doing", () => {
  assert.match(text(data([step(1, [])], { phase: "model" })).plain[1], /thinking/);
  assert.match(text(data([step(1, [])], { phase: "compact" })).plain[1], /compacting the history/);
  assert.match(text(data([step(1, [])], { phase: "verify" })).plain[1], /verifying the result/);
  const many = text(data([step(1, [])], { phase: "tools", inflight: Array.from({ length: 3 }, (_, i) => ({ label: `tool ${i}`, ms: 10, name: "grep", args: "{}" })) }));
  assert.match(many.plain[1], /tool 0/); assert.match(many.plain[2], /\+2 more running/);
});

test("consecutive calls of one kind merge, and a step's time is the model call plus its tools", () => {
  assert.equal(stepSummary([{ name: "read_file" }, { name: "read_file" }, { name: "edit_file" }, { name: "sh" }]), "Read ×2 → Update → Bash");
  assert.equal(stepMs(step(1, [tool("read_file", true, 300), tool("grep", true, 500)])), 1200 + 800);
  assert.equal(stepMs(step(1, [tool("read_file", true, 300), tool("grep", true, 500)], [], { parallel: 2 })), 1200 + 500);
});

test("each step line carries its stage icons; a failed step is marked", () => {
  const r = text(data([step(1, [tool("read_file"), tool("grep")]), step(2, [tool("edit_file"), sh("npm test", false)]), step(3, [])], { live: false }));
  assert.ok(r.plain.some((l) => /^ ?1 ◉ Read → Search/.test(l)), r.plain.join("\n"));
  assert.ok(r.plain.some((l) => /^ ?2 ✎✓ Update → Bash ✗/.test(l)), r.plain.join("\n"));
  assert.ok(r.plain.some((l) => /^ ?3 · replied/.test(l)));
});

test("room decides how many steps show: a few when short, more when tall; older ones fold; the newest is always there", () => {
  const steps = Array.from({ length: 20 }, (_, i) => step(i + 1, [tool("read_file"), tool("grep", i !== 3)]));
  const short = text(data(steps), 8), tall = text(data(steps), 22);
  const shown = (r: typeof short) => r.plain.filter((l) => /^ ?\d+ [◉✎✓·▸]/.test(l)).length;
  assert.ok(shown(short) >= 3 && shown(short) < shown(tall), `short ${shown(short)} < tall ${shown(tall)}`);
  assert.ok(short.plain.some((l) => /… \d+ earlier steps · \d+ tools/.test(l)), short.plain.join("\n"));
  assert.ok(short.plain.some((l) => /^20 /.test(l.trim()) || /^ ?20 /.test(l)), "the newest step is shown");
  assert.ok(short.plain.some((l) => /\/loop: all/.test(l)), "points to /loop for the rest");
  assert.ok(!text(data(steps.slice(0, 3)), 14).plain.some((l) => /earlier step/.test(l)), "plenty of room: nothing folded");
  const six = Array.from({ length: 6 }, (_, i) => step(i + 1, [tool("grep")]));
  assert.ok(!text(data(six, { live: false }), 12).plain.some((l) => /earlier step/.test(l)), "all six fit in the room: nothing folded just to save a line");
});

test("a step with an intervention stays visible even when older, and the note wraps instead of being cut", () => {
  assert.ok(isIntervention("nudged: no edits after 5 reads") && isIntervention("finish rejected: tests fail") && !isIntervention("cache break: system prompt changed"));
  const steps = [step(1, [tool("read_file")], ["nudged: no edits after 5 reads", "cache break: tools changed"]), ...Array.from({ length: 9 }, (_, i) => step(i + 2, [tool("grep")]))];
  const p = text(data(steps), 12).plain.join("\n");
  assert.match(p, /⚑ nudged: no edits after/); assert.match(p, /\n\s+reads\n/);
  assert.doesNotMatch(p, /cache break/);
});

test("clicking a step opens it: every tool call is listed with its result and time", () => {
  const steps = [step(1, [tool("read_file"), tool("edit_file", false, 90)]), step(2, [])];
  const closed = text(data(steps, { open: [] })), open = text(data(steps, { open: [1] }));
  assert.ok(open.lines.length > closed.lines.length);
  assert.ok(open.plain.some((l) => /✗ Update a\.ts/.test(l)) && open.plain.some((l) => /✓ Read a\.ts/.test(l)));
  assert.deepEqual(closed.hits.map((h) => h.step), [1, 2]);
});

test("a finished run shows as LAST RUN: nothing lit, no spinner, a summary with the number of failures", () => {
  const r = text(data([step(1, [tool("grep")]), step(2, [tool("edit_file", false)])], { live: false }));
  assert.equal(r.title, "LAST RUN");
  assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(r.plain.join("")));
  assert.ok(r.plain.some((l) => /2 steps · 2 tools · 1 failed/.test(l)));
});

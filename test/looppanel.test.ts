import assert from "node:assert/strict";
import { test } from "node:test";
import { capNote, isIntervention, renderLoop, stepMs, stepSummary, type LoopData, type LoopStep } from "../cli/tui/looppanel.ts";
import { getTheme } from "../cli/tui/themes.ts";
import { strip } from "../cli/tui/text.ts";

const t = getTheme("dark"), W = 32;
const tool = (name: string, ok = true, ms = 400) => ({ name, args: JSON.stringify({ path: "a.ts" }), ms, ok });
const step = (n: number, tools: ReturnType<typeof tool>[], notes: string[] = [], extra: Partial<LoopStep> = {}): LoopStep => ({ n, t0: 1000 * n, ms: 1200, tools, notes, ...extra });
const data = (steps: LoopStep[], over: Partial<LoopData> = {}): LoopData => ({ live: true, phase: "model", cap: 60, now: 1000 * (steps.length + 1) + 1800, frame: 0, elapsedMs: 41_000, steps, inflight: [], open: [], ...over });
const text = (d: LoopData, rows = 12) => { const r = renderLoop(d, t, W, rows); return { ...r, plain: r.lines.map((l) => strip(l)) }; };

test("consecutive calls of one kind merge into one short phrase", () => {
  assert.equal(stepSummary([{ name: "read_file" }, { name: "read_file" }, { name: "edit_file" }, { name: "sh" }]), "Read ×2 → Update → Bash");
  assert.equal(stepSummary([]), "");
});

test("a step's time is the model call plus its tools; parallel tools overlap", () => {
  assert.equal(stepMs(step(1, [tool("read_file", true, 300), tool("grep", true, 500)])), 1200 + 800);
  assert.equal(stepMs(step(1, [tool("read_file", true, 300), tool("grep", true, 500)], [], { parallel: 2 })), 1200 + 500);
});

test("the step cap says nothing early, a quiet 'of N' past half, and a warning bar near the end", () => {
  assert.deepEqual(capNote(7, 60), { text: "", level: "none" });
  assert.equal(capNote(31, 60).level, "dim");
  assert.equal(capNote(48, 60).level, "warn");
  const early = text(data([step(1, [tool("grep")]), step(2, [])])).plain.join("\n");
  assert.ok(!/60/.test(early) && !/▰/.test(early), "no cap or bar early in a run");
  const late = text(data(Array.from({ length: 50 }, (_, i) => step(i + 1, [tool("grep")])))).plain.join("\n");
  assert.match(late, /▰/); assert.match(late, /50\/60: close to the step limit/);
});

test("live: the current step is marked and says what the loop is doing", () => {
  const think = text(data([step(1, [tool("grep")]), step(2, [])])).plain;
  assert.match(think[0], /step 2 · thinking/);
  const run = text(data([step(1, [tool("grep")]), step(2, [tool("edit_file")])], { phase: "tools", inflight: [{ label: "Editing a.ts", ms: 900 }, { label: "Running tests", ms: 300 }] }));
  assert.match(run.plain[0], /step 2 · running 2 tools/);
  assert.ok(run.plain.some((l) => /Editing a\.ts/.test(l)) && run.plain.some((l) => /Running tests/.test(l)));
  assert.equal(run.title, "LOOP");
});

test("more than three running tools: the rest are counted", () => {
  const inflight = Array.from({ length: 5 }, (_, i) => ({ label: `tool ${i}`, ms: 10 }));
  assert.ok(text(data([step(1, [])], { phase: "tools", inflight })).plain.some((l) => /\+2 more running/.test(l)));
});

test("a small room folds older steps into one summary line and keeps the newest on screen", () => {
  const steps = Array.from({ length: 20 }, (_, i) => step(i + 1, [tool("read_file"), tool("grep", i !== 3)]));
  const r = text(data(steps), 8);
  assert.ok(r.lines.length <= 8 + 2, `fits (${r.lines.length} lines)`);
  assert.ok(r.plain.some((l) => /… \d+ earlier steps · \d+ tools · 1 failed/.test(l)), r.plain.join("\n"));
  assert.ok(r.plain.some((l) => /^20 /.test(l.trim()) || /20 ▸/.test(l)), "the current step is shown");
  assert.ok(!r.plain.some((l) => /^ ?1 [✓✗]/.test(l)), "step 1 is folded away");
  const roomy = text(data(steps.slice(0, 5)), 20);
  assert.ok(!roomy.plain.some((l) => /earlier step/.test(l)), "plenty of room: nothing folded");
});

test("interventions stay visible next to their step; background notes only for the latest steps", () => {
  assert.ok(isIntervention("nudged: no edits after 5 reads") && isIntervention("finish rejected: tests fail") && !isIntervention("cache break: system prompt changed"));
  const steps = [step(1, [tool("read_file")], ["nudged: no edits after 5 reads", "cache break: tools changed"]), step(2, [tool("read_file")]), step(3, [tool("read_file")]), step(4, [tool("edit_file")], ["trimmed ~2k tokens (old output)"])];
  const p = text(data(steps), 20).plain.join("\n");
  assert.match(p, /⚑ nudged: no edits after/); assert.match(p, /\n\s+reads\n/);          // an intervention in an old step is still shown, wrapped rather than cut
  assert.doesNotMatch(p, /cache break/);                         // background noise from an old step is not
  assert.match(p, /· trimmed ~2k tokens/);                       // but it is for the newest steps
});

test("clicking a step opens it: every tool call is listed with its result and time", () => {
  const steps = [step(1, [tool("read_file"), tool("edit_file", false, 90)]), step(2, [])];
  const closed = text(data(steps, { open: [] }));
  const open = text(data(steps, { open: [1] }));
  assert.ok(open.lines.length > closed.lines.length);
  assert.ok(open.plain.some((l) => /✗ Update a\.ts/.test(l)) && open.plain.some((l) => /✓ Read a\.ts/.test(l)));
  assert.deepEqual(closed.hits.map((h) => h.step), [1, 2]);       // each step line is a click target
});

test("a finished run shows as LAST RUN with a summary and no spinner", () => {
  const r = text(data([step(1, [tool("grep")]), step(2, [tool("edit_file", false)])], { live: false }));
  assert.equal(r.title, "LAST RUN");
  assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(r.plain.join("")));
  assert.ok(r.plain.some((l) => /2 steps · 2 tools · 1 failed/.test(l)));
});

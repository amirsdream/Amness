import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, supersede, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({ role: "assistant", content: null, usage: { total_tokens: 10 }, tool_calls: cs.map(([name, a]) => ({ id: `l${++n}`, function: { name, arguments: JSON.stringify(a) } })) });
const scripted = (...replies: Message[]) => { const seen: Message[][] = []; const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return replies.shift() ?? call(["finish", { summary: "." }]); }; return { model, seen }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const obj = { type: "object" } as const;

test("scheduler: read-only calls overlap (capped at 5), writers run alone and in order", async () => {
  let active = 0, peak = 0; const order: string[] = [];
  const read = defineTool({ name: "r", description: "", schema: obj, readOnly: true, run: async () => { peak = Math.max(peak, ++active); await sleep(15); active--; return "r"; } });
  const write = defineTool({ name: "w", description: "", schema: obj, run: async (a: any) => { assert.equal(active, 0); order.push("w" + a.i); await sleep(5); return "w"; } });
  const { model } = scripted(call(...Array.from({ length: 8 }, (_, i): [string, unknown] => ["r", { i }]), ["w", { i: 1 }], ["w", { i: 2 }]), call(["finish", { summary: "." }]));
  const r = await createHarness({ model, tools: [read, write] }).run("x");
  assert.ok(r.finished); assert.equal(peak, 5); assert.deepEqual(order, ["w1", "w2"]);
  const toolMsgs = r.messages.filter((m) => m.role === "tool"); assert.equal(toolMsgs.length, 11);
});

test("scheduler: tools that are neither readOnly nor parallel never overlap", async () => {
  let active = 0, peak = 0;
  const w = defineTool({ name: "w", description: "", schema: obj, run: async () => { peak = Math.max(peak, ++active); await sleep(10); active--; return "ok"; } });
  const { model } = scripted(call(["w", {}], ["w", {}], ["w", {}]));
  await createHarness({ model, tools: [w] }).run("x"); assert.equal(peak, 1);
});

test("stuck: reflection after 3 failing turns, hard stop after 6", async () => {
  const bad = defineTool({ name: "bad", description: "", schema: obj, run: () => { throw new Error("nope"); } });
  const { model, seen } = scripted(...Array.from({ length: 10 }, (_, i) => call(["bad", { i }])));
  const r = await createHarness({ model, tools: [bad], maxSteps: 20 }).run("x");
  assert.equal(r.stopped, "stuck"); assert.equal(r.steps, 6);
  assert.ok(seen.at(-1)!.some((m) => m.role === "user" && /reflect/.test(m.content ?? "")));
});

test("stuck: one success resets the streak", async () => {
  const bad = defineTool({ name: "bad", description: "", schema: obj, run: () => { throw new Error("nope"); } });
  const ok = defineTool({ name: "ok", description: "", schema: obj, run: () => "fine" });
  const { model } = scripted(...[0, 1, 2, 3].map((i) => call(["bad", { i }])).slice(0, 2), call(["ok", {}]), ...[5, 6].map((i) => call(["bad", { i }])), call(["finish", { summary: "." }]));
  const r = await createHarness({ model, tools: [bad, ok] }).run("x"); assert.ok(r.finished);
});

test("wrap-up warning appears 3 steps before the cap", async () => {
  const noop = defineTool({ name: "noop", description: "", schema: obj, run: () => "ok" });
  const { model, seen } = scripted(...Array.from({ length: 12 }, (_, i) => call(["noop", { i }])));
  const r = await createHarness({ model, tools: [noop], maxSteps: 8 }).run("x");
  assert.equal(r.stopped, "maxSteps"); assert.ok(seen.at(-1)!.some((m) => /3 steps left/.test(m.content ?? "")));
});

test("supersede: an older identical call's output is dropped, the newest stays", () => {
  const big = "x".repeat(500);
  const msgs: Message[] = [
    { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "read_file", arguments: '{"path":"f"}' } }] }, { role: "tool", tool_call_id: "a", content: big },
    { role: "assistant", content: null, tool_calls: [{ id: "b", function: { name: "read_file", arguments: '{"path":"f"}' } }] }, { role: "tool", tool_call_id: "b", content: big },
    ...Array.from({ length: 6 }, () => ({ role: "user", content: "pad" }) as Message),
  ];
  supersede(msgs);
  assert.match(msgs[1].content!, /superseded/); assert.equal(msgs[3].content, big);
});

test("condense: strips control codes and progress redraws, collapses repeats, keeps error lines from a cut middle", async () => {
  const { condense } = await import("../src/harness.ts");
  assert.equal(condense("\x1b[31mred\x1b[0m"), "red");
  assert.equal(condense("10%\r50%\r100%\ndone"), "100%\ndone");
  assert.match(condense(Array(50).fill("tick").join("\n")), /tick\n  … previous line repeated 49 more times/);
  const noisy = ["start", ...Array.from({ length: 2000 }, (_, i) => `ok line ${i}`), "FAIL: expected 3 got 4", ...Array.from({ length: 2000 }, (_, i) => `more ${i}`), "end"].join("\n");
  const c = condense(noisy, 3000);
  assert.ok(c.length < 3600 && c.includes("FAIL: expected 3 got 4") && c.startsWith("start") && c.endsWith("end"));
  assert.equal(condense("a\na\nb"), "a\na\nb");   // two repeats are left alone
});

test("supersede: a read of a file edited afterwards is expired", () => {
  const big = "x".repeat(400), call = (id: string, name: string, path: string): Message => ({ role: "assistant", content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify({ path }) } }] });
  const msgs: Message[] = [call("r", "read_file", "a.ts"), { role: "tool", tool_call_id: "r", content: big }, call("e", "edit_file", "a.ts"), { role: "tool", tool_call_id: "e", content: "edited " + big },
    call("o", "read_file", "b.ts"), { role: "tool", tool_call_id: "o", content: big }, ...Array.from({ length: 6 }, () => ({ role: "user", content: "pad" }) as Message)];
  const saved = supersede(msgs, 6, (n) => n === "read_file");
  assert.match(msgs[1].content!, /stale/); assert.equal(msgs[3].content, "edited " + big); assert.equal(msgs[5].content, big); assert.ok(saved > 300);
});

test("compact: cuts well below the budget once over it (so the cached prefix stays stable afterwards)", async () => {
  const { compact } = await import("../src/harness.ts");
  const msgs: Message[] = Array.from({ length: 20 }, (_, i) => ({ role: "tool", tool_call_id: "t" + i, content: "y".repeat(1000) }));
  assert.equal(compact(msgs, 30_000), 0);
  const saved = compact(msgs, 15_000);
  const left = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  assert.ok(left <= 15_000 * 0.7 + 1000 && saved > 0, String(left));
});

test("post-edit check: a failing check is appended to the edit result, a passing one adds nothing", async () => {
  const { createCodeAgent } = await import("../src/index.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  for (const [check, expect] of [["echo BROKEN >&2; exit 1", true], ["true", false]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "amness-chk-")); writeFileSync(join(dir, "a.js"), "x\n");
    const { model, seen } = scripted(call(["read_file", { path: "a.js" }]), call(["edit_file", { path: "a.js", old: "x", new: "y" }]), call(["finish", { summary: "." }]));
    await createCodeAgent({ model, cwd: dir, check, permissions: { mode: () => "yolo" }, memory: false }).run("t");
    const edit = seen.at(-1)!.filter((m) => m.role === "tool")[1].content!;
    assert.equal(/post-edit check/.test(edit) && edit.includes("BROKEN"), expect, edit);
  }
});

test("harness emits trim events when it shrinks noisy output", async () => {
  const noisy = defineTool({ name: "noisy", description: "", schema: obj, run: () => Array(500).fill("progress line").join("\n") });
  const ev: any[] = [];
  const { model } = scripted(call(["noisy", {}]), call(["finish", { summary: "." }]));
  await createHarness({ model, tools: [noisy], onEvent: (e) => ev.push(e) }).run("x");
  assert.ok(ev.some((e) => e.kind === "trim" && e.saved > 300));
});

test("loop guard: cycles of 2-4 different calls are caught, reordered or re-spaced repeats are normalised, varied reads are not flagged", async () => {
  const { findCycle, canonicalCall } = await import("../src/harness.ts");
  assert.deepEqual(findCycle(["a", "b", "a", "b", "a", "b"]), ["a", "b"]);
  assert.deepEqual(findCycle(["x", "a", "b", "c", "a", "b", "c", "a", "b", "c"]), ["a", "b", "c"]);
  assert.equal(findCycle(["a", "b", "a", "b", "a"]), undefined);                    // not three full repetitions yet
  assert.equal(findCycle(["a", "a", "a", "a", "a", "a"]), undefined);               // exact repeats have their own guard
  assert.equal(findCycle(["r1", "r2", "r3", "r4", "r5", "r6"]), undefined);          // reading different things is progress
  assert.equal(canonicalCall("sh", { b: 1, cmd: "npm   test" }), canonicalCall("sh", { cmd: "npm test", b: 1 }));
  assert.notEqual(canonicalCall("read_file", { path: "a", start: 1 }), canonicalCall("read_file", { path: "a", start: 50 }));
  const t = defineTool({ name: "t", description: "", schema: obj, run: () => "ok" });
  // same two calls over and over with nothing changing: the exact-repeat guard stops it
  const ev1: any[] = []; await createHarness({ model: scripted(...[1, 2, 1, 2, 1, 2].map((i) => call(["t", { i }]))).model, tools: [t], maxSteps: 12, onEvent: (e) => ev1.push(e) }).run("x");
  assert.ok(ev1.some((e) => e.kind === "loop"));
  // an edit that is flipped back and forth with a test run in between: every test run is legitimate on its own, but the whole pattern is a cycle
  const flip = defineTool({ name: "flip", description: "", schema: obj, run: (a: any, ctx) => (ctx.emit?.({ kind: "edit", path: "f", created: false, added: 1, removed: 1, diff: "" }), "flipped " + a.to) });
  const ev: any[] = [];
  const { model, seen } = scripted(...Array.from({ length: 14 }, (_, i) => (i % 2 ? call(["t", {}]) : call(["flip", { to: i % 4 === 0 ? "y" : "x" }]))));
  await createHarness({ model, tools: [t, flip], maxSteps: 16, onEvent: (e) => ev.push(e) }).run("x");
  assert.ok(ev.some((e) => e.kind === "loop" && /cycle of 4 calls/.test(e.detail)), JSON.stringify(ev.filter((e) => e.kind === "loop")));
  assert.ok(seen.at(-1)!.some((m) => m.role === "tool" && /going in circles/.test(m.content ?? "")));
  // re-running the same test command after real edits is NOT a repeat
  const quiet: any[] = []; await createHarness({ model: scripted(...[1, 2, 3, 4, 5].flatMap((i) => [call(["flip", { to: "v" + i }]), call(["t", {}])])).model, tools: [t, flip], maxSteps: 14, onEvent: (e) => quiet.push(e) }).run("x");
  assert.ok(!quiet.some((e) => e.kind === "loop"), JSON.stringify(quiet.filter((e) => e.kind === "loop")));
});

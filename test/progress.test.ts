import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker, countFailures, isInspection, inspectedPaths, createHarness, defineTool, type Message, type Model } from "../src/index.ts";

test("countFailures reads the common runners, tsc and lint, and falls back to the exit code", () => {
  assert.equal(countFailures("npm test", "exit=1\nTests: 3 failed, 9 passed, 12 total"), 3);
  assert.equal(countFailures("pytest", "exit=1\n== 2 failed, 5 passed in 0.3s =="), 2);
  assert.equal(countFailures("node --test", "exit=1\nℹ pass 10\nℹ fail 4\n"), 4);
  assert.equal(countFailures("npx tsc --noEmit", "exit=2\na.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2304: y\n"), 2);
  assert.equal(countFailures("go test ./...", "exit=1\nFAIL\tpkg\t0.1s\n"), 1);                                  // no readable count: the failing exit code counts as 1
  assert.equal(countFailures("npm test", "exit=0\n12 passing"), 0);
  assert.equal(countFailures("ls -la", "exit=0\n"), undefined);                                                 // not a check
});

test("tracker: real improvements reset the clock; flat failures, repeated reads and flip-flopping edits do not", () => {
  const t = new ProgressTracker(), run = (n: number) => ({ calls: [{ name: "sh", args: { cmd: "npm test" }, result: `exit=1\n${n} failed` }], edits: [] as { path: string; diff: string }[] });
  assert.ok(t.observe(run(5)).length);                                    // first measurement is information
  assert.equal(t.observe(run(5)).length, 0); assert.equal(t.stale, 1);
  assert.equal(t.observe(run(5)).length, 0); assert.equal(t.stale, 2);
  assert.match(t.observe(run(3))[0], /failures down to 3/); assert.equal(t.stale, 0);
  assert.equal(t.observe(run(4)).length, 0);                              // worse than the best so far is not progress
  const d1 = "@@\n-const x = 1;\n+const x = 2;\n", d2 = "@@\n-const x = 2;\n+const x = 1;\n";
  assert.match(t.observe({ calls: [], edits: [{ path: "a.ts", diff: d1 }] })[0], /first edit to a.ts/);
  assert.equal(t.observe({ calls: [], edits: [{ path: "a.ts", diff: d2 }] }).length, 0);                // undoing the change is not new work
  assert.equal(t.observe({ calls: [], edits: [{ path: "a.ts", diff: d1 }] }).length, 0);                // and neither is redoing it
  assert.match(t.observe({ calls: [], edits: [{ path: "a.ts", diff: "@@\n-const y = 1;\n+const y = 3;\n" }] })[0], /new change to a.ts/);
  const r = { name: "read_file", args: { path: "a.ts" }, result: "1\tx" };
  assert.match(t.observe({ calls: [r], edits: [] })[0], /read something new/); assert.equal(t.observe({ calls: [r], edits: [] }).length, 0);
  assert.match(t.observe({ calls: [{ name: "sh", args: { cmd: "npm test" }, result: "exit=0\n" }], edits: [] })[0], /the checks pass/);
});

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "s" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
const tools = (results: string[]) => { let i = 0; return [defineTool({ name: "sh", description: "", schema: { type: "object" }, run: () => results[Math.min(i++, results.length - 1)] }),
  defineTool({ name: "poke", description: "", schema: { type: "object" }, run: (a: any, ctx) => (ctx.emit?.({ kind: "edit", path: "f.ts", created: false, added: 1, removed: 1, diff: a.flip ? "@@\n-a\n+b\n" : "@@\n-b\n+a\n" }), "poked") })]; };

test("harness: a loop that acts but never improves is told to reflect, then stopped; a loop that improves is left alone", async () => {
  const q = [call("poke", { flip: true }), ...Array.from({ length: 30 }, (_, i) => (i % 2 ? call("poke", { flip: i % 4 === 1 }) : call("sh", { cmd: `npm test -- --run ${i}` })))];
  const seen: Message[][] = [], ev: any[] = [];
  const model: Model = async (m) => (seen.push(m.map((x) => ({ ...x }))), q.shift()!);
  const r = await createHarness({ model, tools: tools(["exit=1\n4 failed"]), stagnationTurns: 4, maxSteps: 40, onEvent: (e) => ev.push(e) }).run("fix");
  assert.equal(r.stopped, "stuck"); assert.match(r.text, /no measurable progress/);
  assert.ok(seen.some((m) => m.some((x) => x.role === "user" && /nothing measurable has improved/.test(x.content ?? ""))));
  assert.ok(ev.some((e) => e.kind === "nudge" && /stagnation/.test(e.detail)));
  // steady improvement: failures 5 -> 4 -> 3 -> 2 -> 1 -> 0 (with edits flipped back and forth in between) never triggers it
  const q2 = [...[5, 4, 3, 2, 1, 0].flatMap((_, i) => [call("poke", { flip: i % 2 === 0, tag: i }), call("sh", { cmd: "npm test" })]), call("finish", { summary: "done" })], ev2: any[] = [];
  const r2 = await createHarness({ model: async () => q2.shift()!, tools: tools(["exit=1\n5 failed", "exit=1\n4 failed", "exit=1\n3 failed", "exit=1\n2 failed", "exit=1\n1 failed", "exit=0\nok"]), stagnationTurns: 2, onEvent: (e) => ev2.push(e) }).run("fix");
  assert.ok(r2.finished && !ev2.some((e) => e.kind === "nudge" || e.kind === "loop"), JSON.stringify(ev2.filter((e) => e.kind === "nudge" || e.kind === "loop")));
  // switched off
  const q3 = Array.from({ length: 8 }, () => call("poke", { flip: true })); q3.push(call("finish", { summary: "." }));
  assert.ok((await createHarness({ model: async () => q3.shift()!, tools: tools(["x"]), stagnationTurns: 3, off: ["stagnation"], maxSteps: 20 }).run("x")).finished);
});

test("a comparison (diff, cmp) is a check: different counts as failing, identical as passing; git diff is not one", () => {
  assert.equal(countFailures("diff out.txt expected.txt", "exit=1\n3c3\n< a\n> b\n"), 1);
  assert.equal(countFailures("diff out.txt expected.txt", "exit=0\n"), 0);
  assert.equal(countFailures("cmp a.dat b.dat", "exit=1\na.dat b.dat differ: byte 5, line 1\n"), 1);
  assert.equal(countFailures("cp a b; diff -q x y && echo IDENTICAL || echo DIFFERENT", "exit=0\nDIFFERENT\n"), 1);   // the exit code of a compound command is the echo's
  assert.equal(countFailures("cp a b; diff -q x y && echo IDENTICAL || echo DIFFERENT", "exit=0\nIDENTICAL\n"), 0);
  assert.equal(countFailures("git diff src/a.ts", "exit=0\n@@ -1 +1 @@\n"), undefined);
});

test("reading through the shell: inspection commands are told from commands that act", () => {
  for (const c of ["xxd /app/data/BOOKS.DAT | head -20", "od -c /app/a.dat", "cd /app && cat src/x.cbl", "grep -n foo a.ts | sort | uniq", "sed -n 1,20p a.ts", "ls -la 2>&1"]) assert.ok(isInspection(c), c);
  for (const c of ["python3 program.py", "cat a > b", "sed -i s/a/b/ a.ts", "find . -delete", "echo $(rm -rf x)", "cobc -x a.cbl", "cp a b"]) assert.ok(!isInspection(c), c);
  assert.deepEqual(inspectedPaths("od -A x -t x1z -v /app/data/ACCOUNTS.DAT | head -20"), ["/app/data/ACCOUNTS.DAT"]);
});

test("tracker: the same file seen again through another command is not new; checksPass after an edit and a passing check", () => {
  const t = new ProgressTracker(), sh = (cmd: string, result = "exit=0\n00 01") => ({ calls: [{ name: "sh", args: { cmd }, result }], edits: [] as { path: string; diff: string }[] });
  assert.match(t.observe({ calls: [{ name: "read_file", args: { path: "/app/data/BOOKS.DAT" }, result: "1\tB001" }], edits: [] })[0], /read something new/);
  for (const c of ["xxd /app/data/BOOKS.DAT", "od -x /app/data/BOOKS.DAT", "od -c /app/data/BOOKS.DAT"]) assert.equal(t.observe(sh(c)).length, 0, c);
  assert.equal(t.stale, 3);
  assert.match(t.observe(sh("od -c /app/data/ACCOUNTS.DAT"))[0], /read something new/);
  assert.ok(!t.checksPass);
  t.observe({ calls: [], edits: [{ path: "/app/program.py", diff: "@@\n+print(1)\n" }] });
  assert.match(t.observe(sh("diff a.out b.out"))[0], /the checks pass/); assert.ok(t.checksPass);
  t.observe({ calls: [], edits: [{ path: "/app/program.py", diff: "@@\n+print(2)\n" }] }); assert.ok(!t.checksPass);       // a pass from before the latest edit says nothing about it
  assert.match(t.observe(sh("diff a.out b.out"))[0], /a check passes after the latest change/); assert.ok(t.checksPass);
  assert.equal(t.observe(sh("diff a.out b.out")).length, 0);                                                                   // the same pass again is not new
});

test("harness: write-first note at steps 6 and 10 while nothing is edited, only when turned on, and never after an edit", async () => {
  const runWith = async (o: { writeFirst?: boolean; off?: any[]; editAt?: number }) => {
    let s = 0; const seen: Message[][] = [];
    const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); s++; return s > 12 ? call("finish", { summary: "." }) : s === o.editAt ? call("poke", { flip: true }) : call("sh", { cmd: `od -c /app/f${s}.dat` }); };
    await createHarness({ model, tools: tools(["exit=0\n0000"]), writeFirst: o.writeFirst, off: o.off, stagnationTurns: 0, maxSteps: 20 }).run("write /app/program.py");
    return seen.map((m) => m.filter((x) => x.role === "user" && /without creating or editing any file/.test(x.content ?? "")).length);
  };
  const on = await runWith({ writeFirst: true });
  assert.equal(on[5], 0); assert.equal(on[6], 1); assert.equal(on[10], 2);   // before the model call of step 6, then step 10
  assert.ok((await runWith({})).every((n) => n === 0));
  assert.ok((await runWith({ writeFirst: true, off: ["wrapup"] })).every((n) => n === 0));
  const edited = await runWith({ writeFirst: true, editAt: 2 }); assert.ok(edited.every((n) => n === 0));
});

test("harness: inspecting through sh counts toward the only-reading nudge", async () => {
  let s = 0; const ev: any[] = [];
  const model: Model = async () => (++s > 13 ? call("finish", { summary: "." }) : call("sh", { cmd: `xxd /app/f${s}.dat | head -5` }));
  await createHarness({ model, tools: tools(["exit=0\n00"]), stagnationTurns: 0, maxSteps: 20, onEvent: (e) => ev.push(e) }).run("x");
  assert.ok(ev.some((e) => e.kind === "nudge" && /explored for 12 turns/.test(e.detail)));
});

test("harness: stalled after an edit and a passing check, the stagnation note says finish instead of 'try another approach'", async () => {
  const q = [call("poke", { flip: true }), call("sh", { cmd: "diff a.out b.out" }), ...Array.from({ length: 6 }, (_, i) => call("sh", { cmd: `python3 p.py ${i}` })), call("finish", { summary: "." })], seen: Message[][] = [];
  await createHarness({ model: async (m) => (seen.push(m.map((x) => ({ ...x }))), q.shift()!), tools: tools(["exit=0\n"]), stagnationTurns: 3, maxSteps: 20 }).run("x");
  const notes = seen.flat().filter((x) => x.role === "user" && /For \d+ turns nothing/.test(x.content ?? ""));
  assert.ok(notes.length && notes.every((x) => /your last check passed/.test(x.content ?? "") && /call `finish` now/.test(x.content ?? "")));
});

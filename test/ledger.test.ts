import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, createHarness, defineTool, type Message, type Model } from "../src/index.ts";

const L = (o?: { testCommand?: string }) => new Ledger(o);
const edit = (l: Ledger, path: string) => l.onEdit({ path, added: 1, removed: 1, created: false });

test("ledger: 'tests pass' needs a passing test run AFTER the last edit", () => {
  const l = L();
  assert.match(l.check("Fixed it. All tests pass.")[0], /no test command was run/);
  l.onCommand("npm test", "exit=0\n12 passing"); assert.deepEqual(l.check("All tests pass."), []);
  edit(l, "src/a.ts"); assert.match(l.check("All tests pass.")[0], /no test run succeeded after your last edit/);
  l.onCommand("npm test", "exit=1\n1 failing"); assert.match(l.check("All tests pass.")[0], /last test run after your final edit failed/);
  l.onCommand("npm test", "exit=0\nok"); assert.deepEqual(l.check("All tests pass."), []);
  const sneaky = L(); sneaky.onCommand("npm test", "exit=0\n3 failed, 9 passed"); assert.ok(sneaky.check("tests pass").length);        // exit 0 with failures in the output is not a pass
});

test("ledger: negated and unrelated wording is not a claim; a verify gate makes test claims moot", () => {
  const l = L();
  for (const s of ["I could not get the tests to pass.", "The tests are still failing, see below.", "Did not run tests.", "Renamed the function across 3 files.", "Fixed the parser in the code."]) assert.deepEqual(l.check(s), [], s);
  assert.deepEqual(l.check("All tests pass.", { gated: true }), []);
});

test("ledger: build, typecheck and lint claims need a matching command", () => {
  const l = L(); assert.match(l.check("Typecheck passes and the build is clean.")[0], /build\/typecheck\/lint is clean/);
  l.onCommand("npx tsc --noEmit", "exit=0\n"); assert.deepEqual(l.check("Typecheck passes."), []);
});

test("ledger: a file named as changed must have been edited (unless a shell command could have changed it)", () => {
  const l = L(); assert.match(l.check("Updated src/auth.ts to validate tokens.")[0], /src\/auth\.ts was changed, but no edit to it was recorded/);
  edit(l, "src/auth.ts"); assert.deepEqual(l.check("Updated src/auth.ts to validate tokens."), []);
  assert.deepEqual(l.check("Fixed the off-by-one in sumTo (i < n → i <= n); test.js passes."), []);       // test.js was run, not changed
  const sh = L(); sh.onCommand("sed -i s/a/b/ lib/x.js", "exit=0\n"); assert.deepEqual(sh.check("Changed lib/x.js."), []);
});

test("ledger: the user's own test command counts as a test command", () => {
  const l = L({ testCommand: "make verify-all" }); l.onCommand("make verify-all", "exit=0\n"); assert.deepEqual(l.check("Tests pass."), []);
});

test("audit: changed files, test-file edits when the task did not ask for them, missing test runs", () => {
  const l = L(); edit(l, "src/a.ts"); edit(l, "test/a.test.ts");
  const a = l.audit("fix the bug in a.ts"); assert.deepEqual(a.changed, ["src/a.ts", "test/a.test.ts"]); assert.equal(a.testsAfterLastEdit, undefined);
  assert.ok(a.notes.some((n) => /test files were modified/.test(n)) && a.notes.some((n) => /no test command was run/.test(n)));
  assert.ok(!l.audit("update the tests for a.ts").notes.some((n) => /test files were modified/.test(n)));
  l.onCommand("npm test", "exit=0\nok"); assert.equal(l.audit("x").testsAfterLastEdit, true);
});

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "l" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
test("harness: a finish that overclaims is rejected with specifics, can be fixed, and emits an audit; after two rejections it is accepted but flagged", async () => {
  const sh = defineTool({ name: "sh", description: "", schema: { type: "object" }, run: (a: any) => (/test/.test(a.cmd) ? "exit=0\n3 passing" : "exit=0\n") });
  const q = [call("finish", { summary: "Done, all tests pass." }), call("sh", { cmd: "npm test" }), call("finish", { summary: "Done, all tests pass." })], seen: Message[][] = [], ev: any[] = [];
  const model: Model = async (m) => (seen.push(m.map((x) => ({ ...x }))), q.shift()!);
  const r = await createHarness({ model, tools: [sh], ledger: new Ledger(), onEvent: (e) => ev.push(e) }).run("fix it");
  assert.ok(r.finished); assert.match(seen[1].at(-1)!.content!, /REJECTED: the record does not support your summary: you say the tests pass, but no test command was run/);
  assert.ok(ev.some((e) => e.kind === "audit"));
  const q2 = [call("finish", { summary: "Tests pass." }), call("finish", { summary: "Tests pass." }), call("finish", { summary: "Tests pass." })], ev2: any[] = [];
  const r2 = await createHarness({ model: async () => q2.shift()!, tools: [sh], ledger: new Ledger(), onEvent: (e) => ev2.push(e) }).run("x");
  assert.ok(r2.finished && r2.steps === 3 && ev2.some((e) => e.kind === "hook" && e.event === "Ledger"));              // never deadlocks
  const q3 = [call("finish", { summary: "Tests pass." })];
  assert.ok((await createHarness({ model: async () => q3.shift()!, tools: [sh], ledger: new Ledger(), off: ["ledger"] }).run("x")).finished);   // ablation switch
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, coverage, coverageCheck, WANTS_ALL, type Message, type Model } from "../src/index.ts";

const call = (id: string, name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const out = (id: string, content: string): Message => ({ role: "tool", tool_call_id: id, content });
const listing = (dir: string, names: string[]) => { const id = `l-${dir}`; return [call(id, "list_files", { path: dir }), out(id, names.map((n) => `${dir}/${n}`).join("\n"))]; };

test("the check only applies to tasks that ask for every file to be looked at", () => {
  for (const t of ["Read each file in cli/tui and write NOTES.md", "go through all the files in src", "document every file in lib", "Review all of the files under app"]) assert.ok(WANTS_ALL.test(t), t);
  for (const t of ["Fix the bug in sum.js", "read the file a.txt", "list files"]) assert.ok(!WANTS_ALL.test(t), t);
});

test("coverage: lists the files never read, ignores errors, uses the folder the task names, and stays silent when it cannot tell", () => {
  const names = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const msgs: Message[] = [{ role: "user", content: "Read each file in cli/tui and summarise" }, ...listing("cli/tui", names), call("r1", "read_file", { path: "cli/tui/a.ts" }), out("r1", "1\tcode"), call("r2", "read_file", { path: "cli/tui/b.ts" }), out("r2", "ERROR: no such file")];
  const c = coverage("Read each file in cli/tui and summarise", msgs)!;
  assert.deepEqual(c.read, ["cli/tui/a.ts"]); assert.deepEqual(c.missing, ["cli/tui/b.ts", "cli/tui/c.ts", "cli/tui/d.ts"]);
  assert.equal(coverage("Fix the bug", msgs), undefined, "not a read-everything task");
  assert.equal(coverage("Read each file in cli/tui", [{ role: "user", content: "t" }]), undefined, "no listing in the transcript");
  assert.equal(coverage("Read each file in cli/tui", [{ role: "user", content: "t\n\n## Handoff from your earlier context\nnote" }, ...listing("cli/tui", names)]), undefined, "history replaced by a handoff");
  const other = [...listing("cli/tui", names), ...listing("cli", ["x.ts", "y.ts", "z.ts"])];
  assert.equal(coverage("Read each file in cli/tui", other)!.listed.length, 4, "the listing of the named folder, not the latest one");
  assert.match(coverageCheck({ task: "Read each file in cli/tui", messages: msgs })!, /you read 1 of the 4 files you listed\. Not read: cli\/tui\/b\.ts, cli\/tui\/c\.ts, cli\/tui\/d\.ts/);
  const done = [...msgs, call("r3", "read_file", { path: "cli/tui/b.ts" }), out("r3", "x"), call("r4", "read_file", { path: "cli/tui/c.ts" }), out("r4", "x"), call("r5", "read_file", { path: "./cli/tui/d.ts" }), out("r5", "x")];
  assert.equal(coverageCheck({ task: "Read each file in cli/tui", messages: done }), undefined);
});

test("code agent: finishing after reading 1 of 4 files is refused with the unread names, and accepted once they are read (refused at most twice)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-cov-")); mkdirSync(join(dir, "src")); for (const f of ["a", "b", "c", "d"]) writeFileSync(join(dir, "src", `${f}.ts`), `export const ${f} = 1;\n`);
  const fin = (id: string): Message => call(id, "finish", { summary: "documented all four files" });
  const script: Message[] = [call("1", "list_files", { path: "src" }), call("2", "read_file", { path: "src/a.ts" }), fin("3"), call("4", "read_file", { path: "src/b.ts" }), call("5", "read_file", { path: "src/c.ts" }), call("6", "read_file", { path: "src/d.ts" }), fin("7")];
  const seen: Message[][] = []; const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return script.shift()!; };
  const r = await createCodeAgent({ model, cwd: dir, memory: false, guidance: false, index: false, stagnationTurns: 0 } as never).run("Read each file in src and describe it");
  assert.equal(r.finished, true); assert.equal(r.steps, 7);
  const refusal = seen[3].filter((m) => m.role === "tool").map((m) => m.content!).find((c) => c.startsWith("REJECTED"))!;
  assert.match(refusal, /you read 1 of the 4 files you listed\. Not read: src\/b\.ts, src\/c\.ts, src\/d\.ts/);
  // a model that keeps refusing to read is let through after two refusals, not trapped
  const stubborn: Message[] = [call("1", "list_files", { path: "src" }), call("2", "read_file", { path: "src/a.ts" }), fin("3"), fin("4"), fin("5")];
  const m2: Model = async () => stubborn.shift()!;
  assert.equal((await createCodeAgent({ model: m2, cwd: dir, memory: false, guidance: false, index: false, stagnationTurns: 0 } as never).run("Read each file in src and describe it")).finished, true);
});

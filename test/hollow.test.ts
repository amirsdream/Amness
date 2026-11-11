import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, createHarness, defineTool, type Event, type Message } from "../src/index.ts";
import { elisionMarker, hollowWhy } from "../src/hollow.ts";

test("elisionMarker: comment lines that stand for left-out code; never a bare ... or a string literal", () => {
  for (const l of ["  // ... rest of the code unchanged ...", "# ... existing code ...", "/* rest of the file stays the same */", "    // existing methods ...", "<!-- ... remaining content ... -->", "// (rest of the implementation)", "  # keep existing imports ..."]) assert.ok(elisionMarker(`a\n${l}\nb`), l);
  for (const l of ["    ...", "const s = \"// rest of the code\";", "// TODO: handle the rest of the input", "# compute the rest of the payment", "pass  # unchanged since 2019"]) assert.equal(elisionMarker(l), undefined, l);
});

test("hollowWhy: a new marker in a write or an edit; not one the file already had; not one in the replaced text", () => {
  const d = mkdtempSync(join(tmpdir(), "amness-hol-")); writeFileSync(join(d, "a.ts"), "export const x = 1;\n// ... rest of the code unchanged ...\n");
  assert.match(hollowWhy(d, "write_file", { path: "b.ts", content: "import x;\n// ... rest of the code unchanged ...\n" })!, /placeholder line/);
  assert.equal(hollowWhy(d, "write_file", { path: "a.ts", content: "export const x = 2;\n// ... rest of the code unchanged ...\n" }), undefined, "the file already had that line");
  assert.match(hollowWhy(d, "edit_file", { path: "c.ts", old: "function f() { return 1 }", new: "function f() {\n  // existing code ...\n}" })!, /placeholder/);
  assert.equal(hollowWhy(d, "edit_file", { path: "c.ts", old: "// existing code ...", new: "// existing code ..." }), undefined);
  assert.match(hollowWhy(d, "apply_patch", { patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-export const x = 1;\n+// ... rest of the file stays the same\n*** End Patch" })!, /placeholder/);
  assert.match(hollowWhy(d, "write_file", { path: "1.", content: "x" })!, /empty or only punctuation/);
});

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `h${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
test("the hollow guard refuses the write before it happens, and full-hollow lets it through", async () => {
  const d = mkdtempSync(join(tmpdir(), "amness-hol-")); writeFileSync(join(d, "a.ts"), "line1\nline2\nline3\n");
  const lead = () => [call("read_file", { path: "a.ts" }), call("write_file", { path: "a.ts", content: "line1\n// ... rest of the code unchanged ...\n" }), call("finish", { summary: "done" })];
  const l1 = lead(); const r = await createCodeAgent({ model: async () => l1.shift()!, cwd: d, memory: false, guidance: false, index: false, permissions: { mode: () => "yolo" } }).run("edit a.ts");
  assert.match(r.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n"), /REFUSED: the new text leaves code out/);
  assert.equal(readFileSync(join(d, "a.ts"), "utf8"), "line1\nline2\nline3\n");
  const l2 = lead(); await createCodeAgent({ model: async () => l2.shift()!, cwd: d, memory: false, guidance: false, index: false, off: ["hollow"], permissions: { mode: () => "yolo" } }).run("edit a.ts");
  assert.match(readFileSync(join(d, "a.ts"), "utf8"), /rest of the code/);
});

test("reread: the first finish is sent back once with the task text; never twice; off by default", async () => {
  const ev: Event[] = [];
  const lead = [call("finish", { summary: "done" }), call("finish", { summary: "1. x: in a.ts" }), call("finish", { summary: "again" })];
  const r = await createHarness({ model: async () => lead.shift()!, reread: true, onEvent: (e) => ev.push(e) }).run("REQ: do x and y");
  assert.equal(r.text, "1. x: in a.ts");
  assert.match(r.messages.find((m) => m.role === "tool")!.content!, /Read the task again:\n---\nREQ: do x and y/);
  assert.equal(ev.filter((e) => e.kind === "rejected" && /reread/.test((e as any).detail)).length, 1);
  const l2 = [call("finish", { summary: "done" })];
  assert.equal((await createHarness({ model: async () => l2.shift()! }).run("x")).text, "done");
  const l3 = [call("finish", { summary: "done" })];
  assert.equal((await createHarness({ model: async () => l3.shift()!, reread: true, off: ["reread"] }).run("x")).text, "done");
});

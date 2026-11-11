import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessVariant, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `e${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "amness-ev-")); writeFileSync(join(d, "a.js"), "exports.x = 1;\n"); return d; };

test("edit:whole-small adds the edit-format rule to the system prompt", async () => {
  let sys = "";
  const m: Model = async (msgs) => { sys ||= msgs[0].content ?? ""; return call("finish", { summary: "ok" }); };
  await harnessVariant(m, "edit:whole-small").run({ name: "c", task: "t", files: {}, check: "true" }, dir());
  assert.match(sys, /for a file under 80 lines, write the whole new file with write_file/);
});

test("edit:delegate: the main model describes the change, the editor subagent (here on another model) applies it", async () => {
  const d = dir(); let mainSys = ""; const editorSaw: string[] = [];
  const lead = [call("task", { agent: "editor", description: "In a.js change `exports.x = 1;` to `exports.x = 2;`" }), call("finish", { summary: "x is 2" })];
  const main: Model = async (msgs) => { mainSys ||= msgs[0].content ?? ""; return lead.shift()!; };
  const steps = [call("read_file", { path: "a.js" }), call("edit_file", { path: "a.js", old: "exports.x = 1;", new: "exports.x = 2;" }), call("finish", { summary: "changed x" })];
  const editor: Model = async (msgs) => { editorSaw.push(msgs[0].content ?? ""); return steps.shift()!; };
  const v = harnessVariant(main, "edit:delegate@edit=small", { modelFor: () => editor });
  const out = await v.run({ name: "c", task: "make x 2", files: {}, check: "true" }, d);
  assert.equal(out.text, "x is 2");
  assert.equal(readFileSync(join(d, "a.js"), "utf8"), "exports.x = 2;\n");
  assert.match(mainSys, /do not edit files yourself/); assert.match(editorSaw[0], /You apply one code change/);
});

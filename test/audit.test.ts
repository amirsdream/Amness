import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, type Guard, type Message, type Model } from "../src/index.ts";

/** A small project, and an agent whose model writes `file` and then tries to finish twice. Returns what each finish got back. */
async function run(task: string, file: string, content: string, off: Guard[] = []) {
  const d = mkdtempSync(join(tmpdir(), "amness-audit-")); mkdirSync(join(d, "src")); mkdirSync(join(d, "test"));
  writeFileSync(join(d, "src/app.ts"), "export const app = () => 1;\n"); writeFileSync(join(d, "test/app.test.ts"), "import { app } from '../src/app.ts';\napp();\n");
  let n = 0; const call = (name: string, args: object): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "a" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
  const q: Message[] = [call("write_file", { path: file, content }), call("finish", { summary: "done" }), call("finish", { summary: "done; it stands alone" }), { role: "assistant", content: "ok" }];
  const seen: Message[][] = [];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return q.shift()!; };
  await createCodeAgent({ model, cwd: d, memory: false, guidance: false, permissions: { mode: () => "yolo" }, off }).run(task);
  return seen.flatMap((m) => m.filter((x) => x.role === "tool")).map((x) => x.content ?? "").filter((c, i, a) => a.indexOf(c) === i);
}

test("audit: a new source file nothing imports refuses the first finish and names it; the agent may say it stands alone and finish again", async () => {
  const outs = await run("add a slugify helper", "src/slugify.ts", "export const slugify = (s: string) => s.toLowerCase();\n");
  const refused = outs.filter((o) => /^REJECTED: nothing imports this new file: src\/slugify\.ts/.test(o));
  assert.equal(refused.length, 1, outs.join("\n---\n"));                              // once: the second finish goes through
});

test("audit: files the task names, tests, and a switched-off guard are not refused", async () => {
  for (const [task, file, off] of [["create src/slugify.ts with a slugify helper", "src/slugify.ts", []], ["add a test", "test/more.test.ts", []], ["add a helper", "src/helper.ts", ["audit"]]] as [string, string, Guard[]][]) {
    const outs = await run(task, file, "export const x = 1;\n", off);
    assert.ok(!outs.some((o) => /nothing imports/.test(o)), `${task}: ${outs.join(" | ")}`);
  }
});

test("audit: only modules count (TS/JS that export, Python that only defines); scripts that run on their own are left alone", async () => {
  assert.equal((await run("add a parser", "src/parser.py", "import re\nPATTERN = re.compile('x')\n\ndef parse(s):\n    return PATTERN.findall(s)\n")).filter((o) => /nothing imports/.test(o)).length, 1);
  for (const [file, content] of [["src/report.py", "import sys\nprint(sys.argv)\n"], ["src/run.js", "console.log('hi');\n"], ["src/tool.py", "def main():\n    pass\n\nmain()\n"]]) {
    assert.ok(!(await run("do it", file, content)).some((o) => /nothing imports/.test(o)), file);
  }
});

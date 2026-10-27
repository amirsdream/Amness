import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guidance, createCodeAgent, type Message, type Model } from "../src/index.ts";

const repo = (files: Record<string, string>) => { const d = mkdtempSync(join(tmpdir(), "amness-g-")); for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); } return d; };
const none = mkdtempSync(join(tmpdir(), "amness-gh-"));      // an empty user-level folder: the real ~/.amness must not leak into tests

test("guidance: root AGENTS.md wins over CLAUDE.md, falls back to it, and an empty repo loads nothing", () => {
  const a = new Guidance(repo({ "AGENTS.md": "Use tabs.", "CLAUDE.md": "Use spaces." }), none).start();
  assert.match(a, /Use tabs\./); assert.ok(!a.includes("Use spaces."));
  const g = new Guidance(repo({ "CLAUDE.md": "Run make test." }), none); assert.match(g.start(), /Run make test\./); assert.deepEqual(g.files, ["CLAUDE.md"]);
  assert.equal(new Guidance(repo({ "a.txt": "x" }), none).start(), "");
});

test("guidance: framed as repository guidance, truncated when huge, user-level file included", () => {
  const user = repo({ "AGENTS.md": "I prefer small commits." });
  const out = new Guidance(repo({ "AGENTS.md": "x".repeat(20_000) }), user).start();
  assert.match(out, /not requests from the user/); assert.match(out, /more characters not shown/); assert.ok(out.length < 9500 + 600); assert.match(out, /I prefer small commits/);
});

test("guidance: a folder's own file is shown once, the first time the agent works there", () => {
  const g = new Guidance(repo({ "AGENTS.md": "root", "pkg/AGENTS.md": "pkg rules", "pkg/sub/deep/a.ts": "x", "other/b.ts": "y" }), none); g.start();
  assert.match(g.nested("pkg/sub/deep/a.ts"), /pkg rules/);
  assert.equal(g.nested("pkg/sub/deep/a.ts"), ""); assert.equal(g.nested("pkg/x.ts"), "");      // already shown
  assert.equal(g.nested("other/b.ts"), ""); assert.equal(g.nested("AGENTS.md"), "");             // nothing nested there; root was shown at start
});

test("agent: instructions ride on the first message; reading inside a folder surfaces that folder's file at the end of the result", async () => {
  const d = repo({ "AGENTS.md": "Always run npm test.", "pkg/AGENTS.md": "pkg uses vitest", "pkg/a.ts": "export const a = 1;\n" });
  process.env.AMNESS_HOME = none;
  const seen: Message[][] = [];
  const replies: Message[] = [{ role: "assistant", content: null, tool_calls: [{ id: "r1", function: { name: "read_file", arguments: '{"path":"pkg/a.ts"}' } }] }, { role: "assistant", content: "done" }];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return replies.shift()!; };
  const agent = createCodeAgent({ model, cwd: d, memory: false, chat: true });
  const r = await agent.chat([], "look at pkg/a.ts");
  assert.match(r.messages.find((m) => m.role === "user")!.content!, /Project instructions[\s\S]*Always run npm test\./);
  const tool = r.messages.find((m) => m.role === "tool")!.content!;
  assert.match(tool, /export const a = 1;/); assert.match(tool, /pkg uses vitest/); assert.ok(tool.indexOf("export const") < tool.indexOf("pkg uses vitest"));
  assert.deepEqual(agent.guidance!.files, ["AGENTS.md", "pkg/AGENTS.md"]);
  const off = createCodeAgent({ model: async () => ({ role: "assistant", content: "ok" }), cwd: d, memory: false, chat: true, guidance: false });
  assert.ok(!(await off.chat([], "hi")).messages[1].content!.includes("Always run npm test."));
});

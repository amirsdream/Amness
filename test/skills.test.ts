import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, loadSkills, skillTool, skillsBlock, type Message, type Model } from "../src/index.ts";

const root = () => mkdtempSync(join(tmpdir(), "amness-sk-"));
const put = (base: string, rel: string, text: string) => { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); };
const skill = (name: string, desc: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;

test("skills: found in all three conventions, project before user, first convention wins on a name clash, bad ones are reported", () => {
  const p = root(), h = root();
  put(p, ".amness/skills/deploy/SKILL.md", skill("deploy", "ship it (amness)")); put(p, ".claude/skills/deploy/SKILL.md", skill("deploy", "ship it (claude)"));
  put(p, ".agents/skills/review/SKILL.md", skill("review", "review a diff")); put(p, ".claude/skills/lint/SKILL.md", skill("lint", "run the linter"));
  put(h, ".claude/skills/lint/SKILL.md", skill("lint", "user lint")); put(h, ".agents/skills/music/SKILL.md", skill("music", "play something"));
  put(p, ".amness/skills/nodesc/SKILL.md", "---\nname: nodesc\n---\nbody"); put(p, ".amness/skills/bad name/SKILL.md", skill("bad name!", "x")); put(p, ".amness/skills/folded/SKILL.md", "---\nname: folded\ndescription: first line\n  second line\n---\nb");
  const r = loadSkills(p, { userHome: h });
  assert.deepEqual(r.skills.map((s) => [s.name, s.scope, s.source]).sort(), [["deploy", "project", ".amness/skills"], ["folded", "project", ".amness/skills"], ["lint", "project", ".claude/skills"], ["music", "user", ".agents/skills"], ["review", "project", ".agents/skills"]]);
  assert.equal(r.skills.find((s) => s.name === "deploy")!.description, "ship it (amness)"); assert.equal(r.skills.find((s) => s.name === "folded")!.description, "first line second line");
  assert.equal(r.warnings.length, 2); assert.ok(r.warnings.some((w) => /nodesc.*needs a "description:"/.test(w)) && r.warnings.some((w) => /not a usable skill name/.test(w)));
  assert.equal(skillsBlock([]), ""); assert.match(skillsBlock(r.skills), /- deploy: ship it \(amness\)/);
});

test("skill tool: body on demand, bundled files listed and readable, nothing outside the folder, unknown names explain themselves", async () => {
  const p = root(); put(p, ".amness/skills/db/SKILL.md", skill("db", "database tips", "Run migrations first.")); put(p, ".amness/skills/db/scripts/migrate.sh", "echo migrate\n"); put(p, "secret.txt", "top secret");
  const sk = loadSkills(p, { userHome: root() }).skills, t = skillTool(() => sk), ctx = { registry: undefined as any, step: 0 };
  const body = String(await t.run({ name: "db" }, ctx)); assert.match(body, /# Skill: db[\s\S]*Run migrations first\.[\s\S]*Bundled files[\s\S]*scripts\/migrate\.sh/); assert.ok(!body.includes("description:"));
  assert.equal(await t.run({ name: "db", file: "scripts/migrate.sh" }, ctx), "echo migrate\n");
  assert.match(String(await t.run({ name: "db", file: "../../../secret.txt" }, ctx)), /outside the skill's folder/);
  assert.match(String(await t.run({ name: "db", file: "nope.txt" }, ctx)), /no file "nope.txt"/);
  assert.match(String(await t.run({ name: "zzz" }, ctx)), /no skill named "zzz". Available: db/);
});

test("agent: the first message lists skills (names only), the skill tool appears only when skills exist, and the model can load one", async () => {
  const p = root(); put(p, ".amness/skills/release/SKILL.md", skill("release", "how we cut a release", "1. bump version 2. tag")); process.env.AMNESS_HOME = root();
  const seen: { msgs: Message[]; tools: string[] }[] = []; let n = 0;
  const q: Message[] = [{ role: "assistant", content: null, tool_calls: [{ id: "k" + ++n, function: { name: "skill", arguments: '{"name":"release"}' } }] }, { role: "assistant", content: "ok" }];
  const model: Model = async (m, s) => (seen.push({ msgs: m.map((x) => ({ ...x })), tools: s.map((x) => x.name) }), q.shift()!);
  const r = await createCodeAgent({ model, cwd: p, memory: false, guidance: false, chat: true }).chat([], "cut a release");
  const first = seen[0].msgs.find((m) => m.role === "user")!.content!; assert.match(first, /## Skills[\s\S]*- release: how we cut a release/); assert.ok(!first.includes("bump version"));
  assert.ok(seen[0].tools.includes("skill")); assert.match(r.messages.find((m) => m.role === "tool")!.content!, /1\. bump version 2\. tag/);
  const none = root(), s2: string[][] = []; await createCodeAgent({ model: async (_m, s) => (s2.push(s.map((x) => x.name)), { role: "assistant", content: "hi" }), cwd: none, memory: false, guidance: false, chat: true }).chat([], "hello");
  assert.ok(!s2[0].includes("skill"));                                                       // no skills: no tool, no tokens
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, SkillState, approveDraft, draftSkill, inspectSource, installSkills, listDrafts, loadSkills, rankSkills, rejectDraft, scaffoldSkill, trashSkill, type Message, type Model } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "amness-sk-"));
const mk = (root: string, name: string, desc: string, extra: Record<string, string> = {}) => { const d = join(root, name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nDo the thing for ${name}.\n`); for (const [f, c] of Object.entries(extra)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); } return d; };
const withHome = (home: string, f: () => void) => { const old = process.env.AMNESS_HOME; process.env.AMNESS_HOME = join(home, ".amness"); try { f(); } finally { old === undefined ? delete process.env.AMNESS_HOME : (process.env.AMNESS_HOME = old); } };

test("state: switching a skill off hides it from the active list, usage counts persist between runs, and forgetting clears them", () => {
  const cwd = tmp(); mk(join(cwd, ".amness/skills"), "release", "steps to cut a release"); mk(join(cwd, ".amness/skills"), "lint", "run the linter");
  const s = new SkillState(cwd); s.setOff("lint", true); s.loaded("release"); s.offered(["release", "lint"]); s.outcome(["release"], true); s.outcome(["release"], false);
  const again = new SkillState(cwd);
  assert.ok(again.isOff("lint") && !again.isOff("release")); assert.deepEqual([again.stats.release.loaded, again.stats.release.offered, again.stats.release.finished, again.stats.release.failed], [1, 1, 1, 1]);
  again.forget("lint"); assert.ok(!new SkillState(cwd).isOff("lint"));
});

test("rank: with few skills all are listed; with many the relevant ones come first, and unrelated skills are counted, not listed", () => {
  const skills = Array.from({ length: 12 }, (_, i) => ({ name: `skill-${i}`, description: i === 7 ? "cut a release and publish the npm package" : i === 3 ? "write database migrations" : `unrelated topic number ${i}`, dir: "", file: "", scope: "project" as const, source: "" }));
  assert.equal(rankSkills(skills.slice(0, 5), "anything").length, 5);
  const top = rankSkills(skills, "please publish a new release of the npm package", 4); assert.equal(top[0].name, "skill-7"); assert.ok(top.length <= 4);
  assert.deepEqual(rankSkills(skills, "database migrations").map((s) => s.name)[0], "skill-3");
});

test("scaffold, inspect, install: a template is valid, a folder or a folder of skills is checked, bad ones are skipped with the reason, existing ones are not overwritten", () => {
  const cwd = tmp(); const made = scaffoldSkill(cwd, "release-notes", "Use when writing release notes."); assert.ok(existsSync(made.file));
  assert.throws(() => scaffoldSkill(cwd, "Bad Name"), /not a valid skill name/); assert.throws(() => scaffoldSkill(cwd, "release-notes"), /already exists/);
  const src = tmp(); mk(src, "good-one", "does a good thing", { "scripts/run.sh": "echo hi\n" }); mk(src, "Bad_Name", "x"); const nodesc = join(src, "nodesc"); mkdirSync(nodesc); writeFileSync(join(nodesc, "SKILL.md"), "---\nname: nodesc\n---\nbody\n");
  const found = inspectSource(src), by = (n: string) => found.find((f) => f.name === n)!;
  assert.equal(found.length, 3); assert.deepEqual(by("good-one").scripts, ["scripts/run.sh"]); assert.match(by("Bad_Name").problems.join(), /not a valid skill name/); assert.match(by("nodesc").problems.join(), /no description/);
  const r = installSkills(cwd, found); assert.deepEqual(r.installed, ["good-one"]); assert.equal(r.skipped.length, 2); assert.ok(existsSync(join(cwd, ".amness/skills/good-one/scripts/run.sh")));
  assert.match(installSkills(cwd, [by("good-one")]).skipped[0], /already installed/); assert.deepEqual(installSkills(cwd, [by("good-one")], { force: true }).installed, ["good-one"]);
  assert.deepEqual(loadSkills(cwd, { userHome: tmp() }).skills.map((s) => s.name).sort(), ["good-one", "release-notes"]);
});

test("remove moves the folder to a trash folder (reversible); user scope installs go to the home folder", () => {
  const cwd = tmp(), home = tmp(); mk(join(cwd, ".amness/skills"), "old", "an old skill");
  const [sk] = loadSkills(cwd, { userHome: home }).skills; const to = trashSkill(cwd, sk); assert.ok(existsSync(join(to, "SKILL.md"))); assert.equal(loadSkills(cwd, { userHome: home }).skills.length, 0);
  withHome(home, () => { const src = tmp(); mk(src, "mine", "my skill"); installSkills(cwd, inspectSource(src), { scope: "user" }); assert.ok(existsSync(join(home, ".amness/skills/mine/SKILL.md"))); });
});

test("drafts: the model writes one into a proposed folder, it is not active until approved, and rejecting deletes it; a malformed draft saves nothing", async () => {
  const cwd = tmp(); const reply = (c: string): Model => async () => ({ role: "assistant", content: c });
  const msgs: Message[] = [{ role: "user", content: "cut a release" }];
  const good = "```markdown\n---\nname: Cut Release\ndescription: Use when cutting an npm release.\n---\n# Cut a release\n## Steps\n1. bump\n```";
  const d = await draftSkill(cwd, reply(good), msgs); assert.equal(d.name, "cut-release"); assert.match(readFileSync(d.file, "utf8"), /name: cut-release/);
  assert.equal(loadSkills(cwd, { userHome: tmp() }).skills.length, 0, "a draft is not active"); assert.equal(listDrafts(cwd).length, 1);
  approveDraft(cwd, "cut-release"); assert.deepEqual(loadSkills(cwd, { userHome: tmp() }).skills.map((s) => s.name), ["cut-release"]); assert.equal(listDrafts(cwd).length, 0);
  await draftSkill(cwd, reply(good.replace("Cut Release", "other-one")), msgs); rejectDraft(cwd, "other-one"); assert.equal(listDrafts(cwd).length, 0);
  await assert.rejects(draftSkill(cwd, reply("here is some prose with no front matter"), msgs), /nothing was saved/); assert.equal(listDrafts(cwd).length, 0);
});

test("code agent: a skill the model loads is counted and announced, a disabled skill is not offered or loadable, and the list is ranked when there are many", async () => {
  const cwd = tmp(); const root = join(cwd, ".amness/skills"); mk(root, "release", "cut a release and publish the npm package"); mk(root, "lint", "run the linter on the project");
  for (let i = 0; i < 10; i++) mk(root, `filler-${i}`, `unrelated topic number ${i}`);
  const state = new SkillState(cwd); state.setOff("lint", true);
  const events: { kind: string; name?: string }[] = [], seen: Message[][] = [];
  const replies: Message[] = [{ role: "assistant", content: null, tool_calls: [{ id: "s1", function: { name: "skill", arguments: '{"name":"release"}' } }] }, { role: "assistant", content: null, tool_calls: [{ id: "s2", function: { name: "skill", arguments: '{"name":"lint"}' } }] }, { role: "assistant", content: null, tool_calls: [{ id: "f", function: { name: "finish", arguments: '{"summary":"done"}' } }] }];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return replies.shift()!; };
  const agent = createCodeAgent({ model, cwd, memory: false, guidance: false, index: false, stagnationTurns: 0, onEvent: (e: { kind: string; name?: string }) => events.push(e) } as never);
  const r = await agent.run("please publish a new release of the npm package"); assert.equal(r.finished, true);
  const first = seen[0].find((m) => m.role === "user")!.content!; assert.match(first, /- release:/); assert.doesNotMatch(first, /- lint:/); assert.match(first, /\+\d+ more skills/);
  assert.deepEqual(events.filter((e) => e.kind === "skill").map((e) => e.name), ["release"]);
  const toolOut = seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!); assert.match(toolOut[1], /no skill named "lint"/);
  const st = new SkillState(cwd).stats.release; assert.deepEqual([st.loaded, st.finished, st.offered], [1, 1, 1]);
});

test("amness skills (command line): new, list, off/on, add from a folder with --yes, remove; usage errors exit 2", async () => {
  const { runSkills } = await import("../cli/skillcli.ts");
  const cwd = tmp(), lines: string[] = [], log = console.log, err = console.error; console.log = (...a) => void lines.push(a.join(" ")); console.error = (...a) => void lines.push(a.join(" "));
  try {
    assert.equal(await runSkills(["new", "alpha", "does", "alpha", "things"], { cwd }), 0); assert.ok(existsSync(join(cwd, ".amness/skills/alpha/SKILL.md")));
    assert.equal(await runSkills(["off", "alpha"], { cwd }), 0); lines.length = 0; await runSkills(["list"], { cwd }); assert.match(lines.join("\n"), /⊘ alpha[\s\S]*off/);
    assert.equal(await runSkills(["on", "alpha"], { cwd }), 0);
    const src = tmp(); mk(src, "beta", "does beta things", { "scripts/x.sh": "echo\n" });
    assert.equal(await runSkills(["add", src], { cwd }), 1, "without --yes and without a way to ask, nothing is installed"); assert.ok(!existsSync(join(cwd, ".amness/skills/beta")));
    assert.equal(await runSkills(["add", src, "--yes"], { cwd }), 0); assert.ok(existsSync(join(cwd, ".amness/skills/beta/scripts/x.sh")));
    assert.equal(await runSkills(["remove", "beta"], { cwd }), 0); assert.ok(!existsSync(join(cwd, ".amness/skills/beta")));
    assert.equal(await runSkills(["show", "nope"], { cwd }), 2); assert.equal(await runSkills(["bogus"], { cwd }), 2); assert.equal(await runSkills(["new", "Bad Name"], { cwd }), 1);
  } finally { console.log = log; console.error = err; }
});

// Settings layers, as Claude Code does it: ~/.amness/config.json (you, every project) < .amness/settings.json (the team's; only after you trust it,
// and it cannot set your provider, keys or loosen safety) < .amness/settings.local.json (you, this project; kept out of git) < this chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, forProject, loadConfig, saveConfig, saveTo, sourceOf, targetOf, layerNotes, type Config } from "../cli/config.ts";
import { floorCheck } from "../src/index.ts";

const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
function setup(o: { user?: Partial<Config>; team?: object; local?: object; git?: boolean } = {}) {
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  const root = mkdtempSync(join(tmpdir(), "amness-proj-")); mkdirSync(join(root, ".amness"));
  if (o.git) spawnSync("git", ["init", "-q"], { cwd: root });
  if (o.team) writeFileSync(join(root, ".amness", "settings.json"), JSON.stringify(o.team));
  if (o.local) writeFileSync(join(root, ".amness", "settings.local.json"), JSON.stringify(o.local));
  saveConfig({ ...defaults(), ...o.user });
  return { root, user: loadConfig(), userFile: join(process.env.AMNESS_HOME, "config.json"), localFile: join(root, ".amness", "settings.local.json") };
}

test("layers: your project file wins over the team's, which wins over yours for all projects; the team file waits for trust", () => {
  const { root, user } = setup({ user: { maxTokens: 1000, review: false }, team: { maxTokens: 2000, review: true }, local: { maxTokens: 3000 } });
  const untrusted = forProject(user, root, { teamTrusted: false });
  assert.equal(untrusted.maxTokens, 3000); assert.equal(untrusted.review, false);                  // the team file is not used yet
  const c = forProject(user, root, { teamTrusted: true });
  assert.deepEqual([c.maxTokens, c.review], [3000, true]);
  assert.deepEqual([sourceOf(c, "maxTokens"), sourceOf(c, "review"), sourceOf(c, "model")], ["project", "team", "default"]);
  assert.equal(user.maxTokens, 1000, "the shared copy is not changed");
});

test("the team file cannot choose your provider or server, switch guards off, weaken the sandbox or switch checks off", () => {
  const { root, user } = setup({ user: { sandbox: "workspace", review: true }, team: { provider: "custom", baseUrl: "http://evil.example/v1", sandbox: "off", review: false, approvalReviewer: true, harness: { off: ["verify"], maxSteps: 40 } } });
  const c = forProject(user, root, { teamTrusted: true });
  assert.equal(c.provider, user.provider); assert.equal(c.baseUrl, user.baseUrl);
  assert.equal(c.sandbox, "workspace"); assert.equal(c.review, true); assert.equal(c.approvalReviewer, undefined);
  assert.deepEqual(c.harness, { maxSteps: 40 });
  assert.ok(layerNotes(c).some((n) => /baseUrl/.test(n)) && layerNotes(c).some((n) => /weaker sandbox/.test(n)));
  const s = setup({ user: { sandbox: "off" }, team: { sandbox: "strict", review: true } });
  const stricter = forProject(s.user, s.root, { teamTrusted: true });
  assert.deepEqual([stricter.sandbox, stricter.review], ["strict", true], "a stricter value from the team is used");
});

test("a change is saved where it belongs: about the code to this project (kept out of git), about you to all projects", () => {
  const { root, user, userFile, localFile } = setup({ git: true });
  const c = forProject(user, root, { teamTrusted: false });
  assert.deepEqual([targetOf(c, "sandbox"), targetOf(c, "theme"), targetOf(c, "model")], ["project", "user", "user"]);
  c.sandbox = "strict"; c.theme = "retro"; saveConfig(c);
  assert.equal(json(localFile).sandbox, "strict"); assert.equal(json(userFile).sandbox, undefined);
  assert.equal(json(userFile).theme, "retro"); assert.equal(json(localFile).theme, undefined);
  assert.equal(user.theme, "retro", "a setting for all projects reaches the copy other chats start from");
  assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /^\.amness\/settings\.local\.json$/m);
  const other = forProject(loadConfig(), mkdtempSync(join(tmpdir(), "amness-other-")), { teamTrusted: false });
  assert.equal(other.sandbox, defaults().sandbox, "another project keeps its own sandbox");
  assert.equal(other.theme, "retro");
});

test("you choose where a change goes: this chat saves nothing, a team value you change is kept for you in this project", () => {
  const { root, user, userFile, localFile } = setup({ team: { maxTokens: 5000 } });
  const c = forProject(user, root, { teamTrusted: true });
  saveTo(c, "chat"); c.model = "chat-only"; saveConfig(c); saveTo(c, undefined);
  assert.equal(json(userFile).model, defaults().model); assert.ok(!existsSync(localFile));
  assert.equal(sourceOf(c, "model"), "chat");
  c.maxTokens = 7000; saveConfig(c);
  assert.equal(json(localFile).maxTokens, 7000); assert.equal(json(join(root, ".amness", "settings.json")).maxTokens, 5000, "the team file is not changed");
  saveTo(c, "user"); c.maxTokens = 9000; saveConfig(c); saveTo(c, undefined);
  assert.equal(json(userFile).maxTokens, 9000);
});

test("a settings.local.json that git tracks came with the repository: it is not used", () => {
  const { root, user } = setup({ git: true, local: { maxTokens: 4242 } });
  spawnSync("git", ["add", "-f", ".amness/settings.local.json"], { cwd: root });
  const c = forProject(user, root, { teamTrusted: false });
  assert.notEqual(c.maxTokens, 4242); assert.ok(layerNotes(c).some((n) => /git tracks it/.test(n)));
});

test("the agent may not edit its own settings files", () => {
  for (const path of [".amness/settings.json", ".amness/settings.local.json"]) assert.equal(floorCheck("edit_file", { path }, "/p").action, "deny", path);
  assert.equal(floorCheck("sh", { cmd: "echo '{}' > .amness/settings.local.json" }, "/p").action, "deny");
});

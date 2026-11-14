import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addCatalog, catalogEntries, fetchEntry, fetchExtension, inspectBundle, installBundle, listInstalled, parseSpec, removeInstalled } from "../cli/extensions.ts";
import { loadPlugins, loadSkills, pluginFingerprint } from "../src/index.ts";
import { loadAgents } from "../src/agents.ts";

/** A fresh home (its parent is private too: user skills live in <parent>/.amness/skills) and a project folder. */
function place() {
  const root = mkdtempSync(join(tmpdir(), "amness-ext-")); process.env.AMNESS_HOME = join(root, "home", ".amness"); mkdirSync(process.env.AMNESS_HOME, { recursive: true });
  const cwd = join(root, "project"); mkdirSync(cwd); return { root, cwd, home: process.env.AMNESS_HOME };
}
const write = (base: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(base, f)), { recursive: true }); writeFileSync(join(base, f), c); } return base; };
const claudeBundle = (dir: string) => write(dir, {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "deploy-tools", version: "1.2.0", description: "Deploy helpers" }),
  "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Use when deploying. Runs the checks first.\n---\nRun ${CLAUDE_PLUGIN_ROOT}/scripts/check.sh before you deploy.\n",
  "agents/reviewer.md": "---\nname: reviewer\ndescription: reviews a deploy\n---\nReview it and report back a short summary.\n",
  "commands/status.md": "---\ndescription: deploy status\n---\nShow the deploy status for $ARGUMENTS\n",
  ".mcp.json": JSON.stringify({ mcpServers: { api: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } } }),
  "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|Edit", hooks: [{ type: "command", command: "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/check.sh" }] }] } }),
  "scripts/check.sh": "#!/bin/sh\nexit 0\n", "server.js": "// a server\n",
});

test("a Claude Code bundle: every part is read without running anything, the parts that run programs are listed", () => {
  const { root } = place(), b = inspectBundle(claudeBundle(join(root, "src")));
  assert.equal(b.kind, "claude"); assert.equal(b.name, "deploy-tools"); assert.equal(b.version, "1.2.0");
  assert.deepEqual(b.skills.map((s) => s.name), ["deploy"]); assert.deepEqual(b.agents.map((a) => a.name), ["reviewer"]); assert.deepEqual(b.commands.map((c) => c.name), ["status"]);
  assert.deepEqual(Object.keys(b.mcp), ["api"]); assert.equal(b.hooks.length, 1); assert.equal(b.hooks[0].matcher, "Bash|Edit");
  assert.ok(b.scripts.includes("scripts/check.sh") && b.scripts.includes("server.js"));
});

test("install: skills, subagents and commands go where Amness reads them, MCP servers into your config, hooks only when chosen; remove takes all of it away", () => {
  const { root, cwd, home } = place(), b = inspectBundle(claudeBundle(join(root, "src")));
  const { record, notes } = installBundle(cwd, b, { scope: "user", source: "test" });
  assert.deepEqual([record.skills, record.agents, record.commands, record.mcp], [["deploy"], ["reviewer"], ["status"], ["deploy-tools-api"]]);
  assert.ok(notes.some((n) => /1 hook\(s\) not installed/.test(n)), "hooks stay out unless you say yes"); assert.ok(!existsSync(join(home, "hooks.json")));
  const skill = loadSkills(cwd).skills.find((s) => s.name === "deploy")!; assert.ok(skill, "the skill is found by the usual loader");
  const kept = join(home, "extensions", "deploy-tools");
  assert.match(readFileSync(skill.file, "utf8"), new RegExp(`Run ${kept.split("\\").join("/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scripts/check.sh`), "${CLAUDE_PLUGIN_ROOT} points at the kept copy");
  assert.ok(existsSync(join(kept, "scripts", "check.sh")));
  assert.ok(loadAgents(cwd).agents.some((a) => a.name === "reviewer")); assert.ok(existsSync(join(home, "commands", "status.md")));
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")); assert.deepEqual(cfg.mcpServers["deploy-tools-api"].args, [`${kept.split("\\").join("/")}/server.js`]);
  assert.equal(listInstalled(cwd).length, 1);
  assert.throws(() => installBundle(cwd, b, { scope: "user", source: "test" }), /already installed/);

  removeInstalled(cwd, listInstalled(cwd)[0]);
  assert.equal(listInstalled(cwd).length, 0); assert.ok(!loadSkills(cwd).skills.some((s) => s.name === "deploy")); assert.ok(!existsSync(kept)); assert.ok(!existsSync(join(home, "commands", "status.md")));
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).mcpServers?.["deploy-tools-api"], undefined);

  const withHooks = installBundle(cwd, b, { scope: "user", source: "test", hooks: true }).record;
  const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  assert.equal(hooks.PreToolUse[0].match, "sh|edit_file|apply_patch", "Claude Code tool names become Amness's"); assert.match(hooks.PreToolUse[0].command, /extensions\/deploy-tools"?\/scripts\/check\.sh/);
  removeInstalled(cwd, withHooks); assert.deepEqual(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")), {});
});

test("a name you already use is not overwritten", () => {
  const { root, cwd } = place(); write(cwd, { ".amness/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: mine\n---\nmine\n" });
  const { record, notes } = installBundle(cwd, inspectBundle(claudeBundle(join(root, "src"))), { scope: "project", source: "test" });
  assert.deepEqual(record.skills, []); assert.ok(notes.some((n) => /skill deploy skipped/.test(n)));
  assert.match(readFileSync(join(cwd, ".amness/skills/deploy/SKILL.md"), "utf8"), /mine/);
});

test("an Amness plugin: its code is scanned for what it can touch, it installs into its own folder and loads; the project fingerprint covers every file", async () => {
  const { root, cwd } = place();
  const src = write(join(root, "jsplug"), { "package.json": JSON.stringify({ name: "@me/amness-hello", version: "0.1.0", amness: { plugin: "main.mjs" } }), "main.mjs": "import { helper } from './lib.mjs';\nexport default { name: 'hello', system: helper() };\n", "lib.mjs": "export const helper = () => 'say hello' + (process.env.X ?? '');\n" });
  const b = inspectBundle(src); assert.equal(b.kind, "amness"); assert.equal(b.name, "amness-hello"); assert.ok(b.plugin!.capabilities.some((c) => /environment/.test(c)));
  installBundle(cwd, b, { scope: "project", source: "test" });
  const r = await loadPlugins(cwd, { trustProject: true }); assert.deepEqual(r.plugins.map((p) => p.name), ["hello"], r.warnings.join("; "));
  const before = pluginFingerprint(cwd); writeFileSync(join(cwd, ".amness/plugins/amness-hello/lib.mjs"), "export const helper = () => 'changed';\n");
  assert.notEqual(pluginFingerprint(cwd), before, "a change in any file of the plugin asks for approval again");
  assert.ok((await loadPlugins(cwd, { trustProject: false })).untrusted, "a project plugin still waits for approval");
});

test("catalogs: a repository with marketplace.json; its entries install from a path inside it, and an entry's own skills list picks skills", () => {
  const { root, cwd } = place();
  const cat = write(join(root, "catalog"), {
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "team-tools", owner: { name: "me" }, plugins: [
      { name: "deploy-tools", source: "./plugins/deploy-tools", description: "Deploy helpers" },
      { name: "doc-skills", source: "./", description: "two of the skills", skills: ["./skills/word", "./skills/pdf"] },
    ] }),
    "skills/word/SKILL.md": "---\nname: word\ndescription: Word files\n---\nx\n", "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: PDF files\n---\nx\n", "skills/other/SKILL.md": "---\nname: other\ndescription: not listed\n---\nx\n",
  });
  claudeBundle(join(cat, "plugins", "deploy-tools"));
  spawnSync("git", ["init", "-q"], { cwd: cat }); spawnSync("git", ["add", "."], { cwd: cat }); spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"], { cwd: cat });
  const { catalog, entries } = addCatalog(cat); assert.equal(catalog.name, "team-tools"); assert.deepEqual(entries.map((e) => e.name), ["deploy-tools", "doc-skills"]);
  assert.equal(catalogEntries().length, 2);
  const docs = catalogEntries().find((e) => e.name === "doc-skills")!, f = fetchEntry(docs);
  try { assert.deepEqual(inspectBundle(f.dir, docs.entry).skills.map((s) => s.name).sort(), ["pdf", "word"], "only the skills the entry lists"); } finally { f.cleanup(); }
  const dt = catalogEntries().find((e) => e.name === "deploy-tools")!, g = fetchEntry(dt);
  try { assert.equal(inspectBundle(g.dir, dt.entry).skills[0].name, "deploy"); installBundle(cwd, inspectBundle(g.dir, dt.entry), { scope: "project", source: g.label, catalog: dt.catalog }); } finally { g.cleanup(); }
  assert.equal(listInstalled(cwd)[0].catalog, "team-tools");
  assert.throws(() => fetchEntry({ ...dt, source: "../outside" }), /leaves the catalog/);
});

test("sources: npm, a GitHub folder link, owner/repo, a git URL and a folder are told apart", () => {
  assert.deepEqual(parseSpec("npm:@me/plug@1.2.0"), { source: "npm", package: "@me/plug", version: "1.2.0" });
  assert.deepEqual(parseSpec("https://github.com/acme/tools/tree/main/plugins/x"), { source: "git-subdir", url: "https://github.com/acme/tools.git", ref: "main", path: "plugins/x" });
  assert.deepEqual(parseSpec("acme/tools", "/nonexistent-base"), { source: "github", repo: "acme/tools" });
  assert.deepEqual(parseSpec("git@github.com:acme/tools.git"), { source: "url", url: "git@github.com:acme/tools.git" });
  assert.deepEqual(parseSpec("./my-plugin"), { source: "path", path: "./my-plugin" });
  assert.throws(() => fetchExtension({ source: "archive", url: "https://x/y.zip" }), /not supported yet/);
});

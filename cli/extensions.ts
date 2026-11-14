// Plugins from open-source repositories: a Claude Code plugin bundle (skills, agents, commands, MCP servers, hooks) or an Amness plugin
// (definePlugin code), from a folder, a git URL, a GitHub owner/repo, an npm package, or an entry in a catalog (a repository with a
// .claude-plugin/marketplace.json). Nothing here runs code: an install copies files into the folders Amness already reads, writes MCP servers
// and hooks into the usual config files (so the usual trust rules apply), and records every file it made so `remove` takes all of it away.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { inspectSource, scanSource, skillsDir, type Found } from "../src/index.ts";
import { home } from "./config.ts";
import { addServer, removeServer, type FileScope } from "./mcpconfig.ts";

export type ExtScope = "user" | "project";
/** Where a plugin comes from, as a catalog entry writes it (see the Claude Code marketplace reference); a plain string is a path, URL or shorthand. */
export type ExtSource = string | { source: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string; package?: string; version?: string };
type McpCfg = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: string; headers?: Record<string, string> };

/** What a plugin folder holds, read without running anything. */
export type Bundle = {
  kind: "claude" | "amness"; name: string; version?: string; description: string; root: string;
  skills: Found[]; agents: { name: string; file: string }[]; commands: { name: string; file: string }[];
  mcp: Record<string, McpCfg>; hooks: { event: string; matcher?: string; command: string }[];
  /** An Amness plugin: its entry file, what its code can touch, and whether it has dependencies to install. */
  plugin?: { entry: string; capabilities: string[]; dependencies: string[] };
  /** Program files in the bundle (scripts its hooks, commands or skills may run). */
  scripts: string[]; warnings: string[];
};
/** One installed plugin, in `extensions.json` of its scope. */
export type Installed = {
  name: string; kind: Bundle["kind"]; scope: ExtScope; source: string; spec?: ExtSource; catalog?: string; commit?: string; version?: string; at: string;
  files: string[]; mcp: string[]; hooks: { event: string; command: string }[]; skills: string[]; agents: string[]; commands: string[];
};
export type Catalog = { name: string; url: string; added: string };

/** Catalogs people can add with one choice. None is added by itself: you pick. */
export const KNOWN_CATALOGS = [
  { url: "https://github.com/anthropics/claude-plugins-official", label: "Claude plugins directory (Anthropic)", hint: "about 300 plugins from Anthropic and partners; many are MCP servers or skills" },
  { url: "https://github.com/anthropics/skills", label: "Agent skills (Anthropic)", hint: "document skills (Word, Excel, PowerPoint, PDF) and example skills" },
  { url: "https://github.com/anthropics/claude-code", label: "Claude Code plugins (Anthropic)", hint: "code review, commit commands, feature development and more" },
];

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PROGRAM = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"]);
/** Claude Code tool names in hook matchers, and the Amness tools they mean. */
const TOOL_NAMES: Record<string, string> = { Bash: "sh", Edit: "edit_file|apply_patch", MultiEdit: "edit_file|apply_patch", Write: "write_file", Read: "read_file", Grep: "grep", Glob: "list_files", LS: "list_files", WebFetch: "fetch_url", WebSearch: "web_search", Task: "task" };

// ---------------------------------------------------------------- where things live
/** The Amness folder of a scope: `~/.amness` (or $AMNESS_HOME) for your own, `<project>/.amness` for one project. */
export const scopeDir = (cwd: string, scope: ExtScope) => (scope === "user" ? home() : join(cwd, ".amness"));
const userBase = () => (process.env.AMNESS_HOME ? resolve(process.env.AMNESS_HOME, "..") : homedir());
const agentsDir = (cwd: string, scope: ExtScope) => join(scope === "user" ? userBase() : cwd, ".amness", "agents");
const commandsDir = (cwd: string, scope: ExtScope) => join(scopeDir(cwd, scope), "commands");
const pluginsDir = (cwd: string, scope: ExtScope) => join(scopeDir(cwd, scope), "plugins");
const hooksFile = (cwd: string, scope: ExtScope) => join(scopeDir(cwd, scope), "hooks.json");
/** MCP servers of a project plugin go to your own project file, not the shared .mcp.json. */
const mcpScope = (scope: ExtScope): FileScope => (scope === "user" ? "user" : "local");
const recordFile = (cwd: string, scope: ExtScope) => join(scopeDir(cwd, scope), "extensions.json");
const keepDir = (cwd: string, scope: ExtScope, name: string) => join(scopeDir(cwd, scope), "extensions", name);
const readJson = (f: string): any => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const writeJson = (f: string, v: unknown) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };

export function listInstalled(cwd: string): Installed[] {
  return (["project", "user"] as ExtScope[]).flatMap((s) => ((readJson(recordFile(cwd, s))?.installed ?? []) as Installed[]).map((x) => ({ ...x, scope: s })));
}
const saveRecords = (cwd: string, scope: ExtScope, list: Installed[]) => writeJson(recordFile(cwd, scope), { installed: list.filter((x) => x.scope === scope) });

// ---------------------------------------------------------------- getting a source onto disk
const git = (args: string[], cwd?: string) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
/** owner/repo on GitHub (an owner starts with a letter or digit, so ./x and ../x stay folders). */
const SHORTHAND = /^\w[\w.-]*\/[\w.-]+$/;
const repoUrl = (u: string) => (SHORTHAND.test(u) ? `https://github.com/${u}.git` : u);

/** A source on disk, with what to show for it and the commit it came from. `cleanup` removes any temporary clone. */
export type Fetched = { dir: string; label: string; commit?: string; cleanup: () => void };
export function fetchExtension(spec: ExtSource, o: { base?: string } = {}): Fetched {
  const s = typeof spec === "string" ? parseSpec(spec, o.base) : spec;
  if (s.source === "path") {
    const dir = resolve(o.base ?? process.cwd(), s.path ?? ".");
    if (o.base && !(dir === resolve(o.base) || dir.startsWith(resolve(o.base) + sep))) throw new Error(`${s.path} leaves the catalog's folder`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${s.path} is not a folder`);
    return { dir, label: dir, cleanup: () => {} };
  }
  if (s.source === "npm") {
    if (!s.package || !/^(@[\w.-]+\/)?[\w.-]+$/.test(s.package)) throw new Error("an npm source needs a package name");
    const tmp = mkdtempSync(join(tmpdir(), "amness-ext-")), want = s.version ? `${s.package}@${s.version}` : s.package;
    const r = spawnSync("npm", ["pack", want, "--silent", "--pack-destination", tmp], { encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" });
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (r.status !== 0 || !tgz) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`npm pack ${want} failed: ${(r.stderr || "").trim().split("\n").pop() || "not found"}`); }
    const x = spawnSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
    if (x.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error("could not unpack the npm package"); }
    return { dir: join(tmp, "package"), label: `npm:${want}`, commit: tgz.replace(/\.tgz$/, ""), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }
  const url = repoUrl(s.source === "github" ? s.repo ?? "" : s.url ?? ""), sub = s.source === "git-subdir" ? s.path : s.path;
  if (!url) throw new Error(`a ${s.source} source needs a repository`);
  if (!["github", "url", "git", "git-subdir"].includes(s.source)) throw new Error(`a "${s.source}" source is not supported yet (folders, git, GitHub and npm are)`);
  const tmp = mkdtempSync(join(tmpdir(), "amness-ext-")), clone = join(tmp, "repo");
  const r = git(["clone", "--depth", "1", ...(s.ref ? ["--branch", s.ref] : []), "--", url, clone]);
  if (r.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`git clone ${url} failed: ${(r.stderr || r.error?.message || "").trim().split("\n").pop()}`); }
  if (s.sha) { const f = git(["fetch", "--depth", "1", "origin", s.sha], clone); const c = f.status === 0 ? git(["checkout", "-q", s.sha], clone) : f; if (c.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`commit ${s.sha} is not in ${url}`); } }
  const dir = sub ? resolve(clone, sub) : clone;
  if (!(dir === clone || dir.startsWith(clone + sep)) || !existsSync(dir)) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`${sub} is not a folder in ${url}`); }
  const commit = git(["rev-parse", "HEAD"], clone).stdout?.trim() || undefined;
  return { dir, label: url.replace(/\.git$/, "") + (sub ? `/${sub}` : ""), commit, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** A typed source: a folder, `npm:<package>[@version]`, `owner/repo`, a git URL, or a GitHub link to a folder (`…/tree/<branch>/<path>`). */
export function parseSpec(text: string, base?: string): Exclude<ExtSource, string> {
  const t = text.trim();
  const npm = /^npm:((?:@[\w.-]+\/)?[\w.-]+)(?:@([\w.^~<>=*-]+))?$/.exec(t); if (npm) return { source: "npm", package: npm[1], version: npm[2] };
  const tree = /^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+))?$/.exec(t); if (tree) return { source: "git-subdir", url: tree[1] + ".git", ref: tree[2], path: tree[3] };
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(t)) return { source: "url", url: t };
  if (/^\w[\w.-]*\/[\w.-]+$/.test(t) && !existsSync(resolve(base ?? process.cwd(), t))) return { source: "github", repo: t };
  return { source: "path", path: t };
}

// ---------------------------------------------------------------- reading a plugin folder
/** What a folder holds, as a Claude Code bundle or an Amness plugin. `entry` is a catalog entry, whose `skills` / `agents` / `commands` add to the folder's (or, for `skills`, pick from it). */
export function inspectBundle(dir: string, entry: Record<string, any> = {}): Bundle {
  const manifest = readJson(join(dir, ".claude-plugin", "plugin.json")) ?? {}, pkg = readJson(join(dir, "package.json")) ?? {}, warnings: string[] = [];
  const name = String(entry.name ?? manifest.name ?? pkg.name ?? basename(dir)).replace(/^@[\w.-]+\//, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const base = { name, version: manifest.version ?? pkg.version ?? entry.version, description: String(entry.description ?? manifest.description ?? pkg.description ?? ""), root: dir, skills: [] as Found[], agents: [] as Bundle["agents"], commands: [] as Bundle["commands"], mcp: {} as Bundle["mcp"], hooks: [] as Bundle["hooks"], warnings };
  const inside = (p: string) => { const a = resolve(dir, p); return a === dir || a.startsWith(dir + sep) ? a : undefined; };
  const paths = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string").map((p) => { const a = inside(p); if (!a) warnings.push(`${p} leaves the plugin folder: skipped`); return a; }).filter((x): x is string => !!x && existsSync(x));

  // An Amness plugin: package.json says so ("amness": { "plugin": "<file>" }), or there is an amness-plugin.* file.
  const entryFile = typeof pkg.amness?.plugin === "string" ? inside(pkg.amness.plugin) : ["amness-plugin.mjs", "amness-plugin.js", "amness-plugin.ts"].map((f) => join(dir, f)).find(existsSync);
  if (entryFile && existsSync(entryFile)) {
    const code = walkFiles(dir).filter((f) => /\.(m?js|cjs|ts)$/.test(f) && !f.includes("node_modules")).map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n");
    return { ...base, kind: "amness", plugin: { entry: relative(dir, entryFile), capabilities: scanSource(code).map((c) => c.label), dependencies: Object.keys(pkg.dependencies ?? {}) }, scripts: [] };
  }

  // A Claude Code bundle: the standard layout, plus what plugin.json and the catalog entry add.
  const skillRoots = entry.skills ? paths(entry.skills) : [...(existsSync(join(dir, "skills")) ? [join(dir, "skills")] : []), ...paths(manifest.skills)];
  if (!skillRoots.length && existsSync(join(dir, "SKILL.md"))) skillRoots.push(dir);
  const seen = new Set<string>();
  for (const r of skillRoots) for (const f of inspectSource(r)) if (!seen.has(f.name)) { seen.add(f.name); base.skills.push(f); }
  const mdIn = (v: unknown, fallback: string) => { const list = v !== undefined ? paths(v) : existsSync(join(dir, fallback)) ? [join(dir, fallback)] : []; return list.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".md")).map((f) => join(p, f)) : p.endsWith(".md") ? [p] : [])); };
  for (const f of mdIn(entry.agents ?? manifest.agents, "agents")) base.agents.push({ name: basename(f, ".md"), file: f });
  if (manifest.commands && typeof manifest.commands === "object" && !Array.isArray(manifest.commands)) {
    for (const [cmd, v] of Object.entries(manifest.commands as Record<string, any>)) { const f = typeof v?.source === "string" ? inside(v.source) : undefined; if (f && existsSync(f)) base.commands.push({ name: cmd, file: f }); else if (typeof v?.content === "string") warnings.push(`command ${cmd} is written inline in plugin.json: not supported yet`); }
  } else for (const f of mdIn(entry.commands ?? manifest.commands, "commands")) base.commands.push({ name: basename(f, ".md"), file: f });

  const mcpParts = [readJson(join(dir, ".mcp.json"))?.mcpServers ?? readJson(join(dir, ".mcp.json")), ...(Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers ? [manifest.mcpServers] : [])];
  for (const part of mcpParts) {
    const m = typeof part === "string" ? (/\.(mcpb|dxt)$/.test(part) ? (warnings.push(`MCP bundle ${part}: not supported yet`), undefined) : readJson(inside(part) ?? "")?.mcpServers ?? readJson(inside(part) ?? "")) : part;
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m as Record<string, McpCfg>)) if (v && typeof v === "object" && (v.command || v.url)) base.mcp[k] = v;
  }
  const hookParts = [readJson(join(dir, "hooks", "hooks.json"))?.hooks, ...(Array.isArray(manifest.hooks) ? manifest.hooks : manifest.hooks ? [manifest.hooks] : []).map((h: unknown) => (typeof h === "string" ? readJson(inside(h) ?? "")?.hooks : h)), entry.hooks];
  for (const part of hookParts) if (part && typeof part === "object") for (const [event, groups] of Object.entries(part as Record<string, any[]>)) {
    if (!HOOK_EVENTS.has(event)) { warnings.push(`hook event ${event} does not exist in Amness: skipped`); continue; }
    for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks ?? []) if (h?.type === "command" && typeof h.command === "string") base.hooks.push({ event, matcher: g.matcher, command: h.command });
      else if (h?.type) warnings.push(`a ${h.type} hook on ${event}: only command hooks are supported`);
  }
  if (manifest.lspServers || existsSync(join(dir, ".lsp.json"))) warnings.push("it has language-server settings: Amness uses its own (/lsp)");
  if (existsSync(join(dir, "bin"))) warnings.push("its bin/ programs are not put on the agent's PATH");
  if (manifest.userConfig) warnings.push("it asks for settings (userConfig): fill them in where its files use ${user_config.…}");
  // A catalog entry that picks skills from a bigger repository brings only those skills' files (and what its own parts point at), not every script in the repository.
  const picked = entry.skills ? base.skills.map((s) => relative(dir, s.dir).split(sep).join("/") + "/") : undefined;
  const scripts = walkFiles(dir).filter((f) => PROGRAM.test(f) && !f.includes("node_modules") && (!picked || picked.some((p) => f.startsWith(p))));
  return { ...base, kind: "claude", scripts };
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) { if (e === ".git") continue; const p = join(dir, e); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) { if (out.length < 5000) walkFiles(p, base, out); } else out.push(relative(base, p).split(sep).join("/")); }
  return out;
}

/** Lines for the install dialog: everything the plugin brings, the parts that run commands first. */
export function describeBundle(b: Bundle): string[] {
  const out: string[] = [`${b.kind === "amness" ? "Amness plugin" : "plugin"} ${b.name}${b.version ? ` ${b.version}` : ""}${b.description ? `: ${b.description}` : ""}`];
  if (b.plugin) {
    out.push(`code that runs inside Amness: ${b.plugin.entry}`);
    if (b.plugin.capabilities.length) out.push(`its code ${b.plugin.capabilities.join(", ")}`);
    if (b.plugin.dependencies.length) out.push(`needs packages: ${b.plugin.dependencies.slice(0, 8).join(", ")} (installed with npm, install scripts off)`);
  }
  for (const [k, v] of Object.entries(b.mcp)) out.push(`MCP server ${k}: ${v.url ?? [v.command, ...(v.args ?? [])].join(" ")}`);
  for (const h of b.hooks) out.push(`hook on ${h.event}${h.matcher ? ` (${h.matcher})` : ""}: ${h.command}`);
  if (b.skills.length) out.push(`skills: ${b.skills.map((s) => s.name + (s.problems.length ? " (has problems: skipped)" : "")).join(", ")}`);
  if (b.agents.length) out.push(`subagents: ${b.agents.map((a) => a.name).join(", ")}`);
  if (b.commands.length) out.push(`commands: ${b.commands.map((c) => "/" + c.name).join(", ")}`);
  if (b.scripts.length) out.push(`program files: ${b.scripts.slice(0, 6).join(", ")}${b.scripts.length > 6 ? ` and ${b.scripts.length - 6} more` : ""}`);
  for (const w of b.warnings) out.push(`note: ${w}`);
  if (out.length === 1) out.push("note: nothing in it that Amness can use");
  return out;
}

// ---------------------------------------------------------------- installing and removing
const ROOT_VARS = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g;
const fill = (text: string, root: string) => text.replace(ROOT_VARS, root.split(sep).join("/"));
const fillDeep = (v: any, root: string): any => (typeof v === "string" ? fill(v, root) : Array.isArray(v) ? v.map((x) => fillDeep(x, root)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, root)])) : v);
const matcherFor = (m?: string) => (m ? m.split("|").map((x) => TOOL_NAMES[x.trim()] ?? x.trim()).join("|") : undefined);

/**
 * Install a read bundle into a scope. The whole folder is kept under `.amness/extensions/<name>` (its scripts run from there); skills, subagents and
 * commands are copied into the folders Amness reads, with ${CLAUDE_PLUGIN_ROOT} filled in; MCP servers and (only with `hooks: true`) hooks go into
 * the usual config files. A name another plugin or your own files already use is skipped and said so. Returns what was installed.
 */
export function installBundle(cwd: string, b: Bundle, o: { scope: ExtScope; source: string; spec?: ExtSource; catalog?: string; commit?: string; hooks?: boolean; replace?: boolean }): { record: Installed; notes: string[] } {
  if (!NAME.test(b.name)) throw new Error(`"${b.name}" is not a usable plugin name`);
  const all = listInstalled(cwd), old = all.find((x) => x.name === b.name && x.scope === o.scope);
  if (old && !o.replace) throw new Error(`${b.name} is already installed (${o.scope === "user" ? "all your projects" : "this project"}): /plugins update ${b.name}`);
  if (old) removeInstalled(cwd, old);
  const notes: string[] = [], files: string[] = [], keep = keepDir(cwd, o.scope, b.name), rec: Installed = { name: b.name, kind: b.kind, scope: o.scope, source: o.source, spec: o.spec, catalog: o.catalog, commit: o.commit, version: b.version, at: new Date().toISOString(), files, mcp: [], hooks: [], skills: [], agents: [], commands: [] };
  const own = new Set(listInstalled(cwd).flatMap((x) => x.files));
  const put = (to: string, write: () => void, what: string) => { if (existsSync(to) && !own.has(to)) { notes.push(`${what} skipped: ${to} already exists`); return false; } mkdirSync(dirname(to), { recursive: true }); write(); files.push(to); return true; };

  rmSync(keep, { recursive: true, force: true }); mkdirSync(dirname(keep), { recursive: true });
  cpSync(b.root, keep, { recursive: true, filter: (p) => basename(p) !== ".git" }); files.push(keep);

  if (b.kind === "amness" && b.plugin) {
    const dest = join(pluginsDir(cwd, o.scope), b.name);
    if (put(dest, () => cpSync(keep, dest, { recursive: true }), `plugin ${b.name}`)) {
      if (b.plugin.dependencies.length) {
        const r = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: dest, encoding: "utf8", timeout: 300_000, shell: process.platform === "win32" });
        if (r.status !== 0) notes.push(`npm install failed in ${dest}: ${(r.stderr || "").trim().split("\n").pop()}`);
      }
      notes.push(o.scope === "project" ? "it loads after you approve it (project plugins ask first)" : "it loads at the next start, or now with /reload-plugins");
    }
  }
  for (const s of b.skills) {
    if (s.problems.length) { notes.push(`skill ${s.name} skipped: ${s.problems.join("; ")}`); continue; }
    const to = join(skillsDir(cwd, o.scope), s.name), from = join(keep, relative(b.root, s.dir));
    if (put(to, () => { cpSync(from, to, { recursive: true }); fillTree(to, keep); }, `skill ${s.name}`)) rec.skills.push(s.name);
  }
  for (const a of b.agents) { const to = join(agentsDir(cwd, o.scope), `${a.name}.md`); if (put(to, () => writeFileSync(to, fill(readFileSync(a.file, "utf8"), keep)), `subagent ${a.name}`)) rec.agents.push(a.name); }
  for (const c of b.commands) { const to = join(commandsDir(cwd, o.scope), `${c.name}.md`); if (put(to, () => writeFileSync(to, fill(readFileSync(c.file, "utf8"), keep)), `command /${c.name}`)) rec.commands.push(c.name); }
  for (const [k, v] of Object.entries(b.mcp)) {
    const id = `${b.name}-${k}`.replace(/[^\w.-]+/g, "-").slice(0, 40);
    try { addServer(mcpScope(o.scope), cwd, id, fillDeep(v, keep)); rec.mcp.push(id); } catch (e) { notes.push(`MCP server ${k} skipped: ${(e as Error).message}`); }
  }
  if (b.hooks.length && !o.hooks) notes.push(`${b.hooks.length} hook(s) not installed (you chose not to): they would run commands at fixed points of every turn`);
  if (b.hooks.length && o.hooks) {
    const f = hooksFile(cwd, o.scope), j = readJson(f) ?? {};
    for (const h of b.hooks) { const def = { command: fill(h.command, keep), ...(matcherFor(h.matcher) ? { match: matcherFor(h.matcher) } : {}) }; (j[h.event] ??= []).push(def); rec.hooks.push({ event: h.event, command: def.command }); }
    writeJson(f, j); notes.push("hooks written for Claude Code may expect its tool names and input; check them with /hooks");
  }
  saveRecords(cwd, o.scope, [...listInstalled(cwd).filter((x) => !(x.name === b.name && x.scope === o.scope)), rec]);
  return { record: rec, notes };
}

/** Fill ${CLAUDE_PLUGIN_ROOT} in the Markdown files of a copied skill. */
function fillTree(dir: string, root: string) { for (const f of walkFiles(dir)) if (extname(f) === ".md") { const p = join(dir, f), t = readFileSync(p, "utf8"); if (ROOT_VARS.test(t)) writeFileSync(p, fill(t, root)); ROOT_VARS.lastIndex = 0; } }

/** Take an installed plugin away: every file it made, its MCP servers and its hooks. */
export function removeInstalled(cwd: string, r: Installed): string[] {
  const gone: string[] = [];
  for (const f of r.files) if (existsSync(f)) { rmSync(f, { recursive: true, force: true }); gone.push(f); }
  for (const id of r.mcp) removeServer(cwd, id, mcpScope(r.scope));
  if (r.hooks.length) {
    const f = hooksFile(cwd, r.scope), j = readJson(f);
    if (j) { for (const h of r.hooks) j[h.event] = (j[h.event] ?? []).filter((d: any) => d?.command !== h.command); for (const k of Object.keys(j)) if (Array.isArray(j[k]) && !j[k].length) delete j[k]; writeJson(f, j); }
  }
  saveRecords(cwd, r.scope, listInstalled(cwd).filter((x) => !(x.name === r.name && x.scope === r.scope)));
  return gone;
}

// ---------------------------------------------------------------- catalogs
const catalogFile = () => join(home(), "catalogs.json");
const catalogClone = (name: string) => join(home(), "catalogs", name);
export const listCatalogs = (): Catalog[] => readJson(catalogFile())?.catalogs ?? [];
export type CatalogEntry = { name: string; description: string; catalog: string; source: ExtSource; entry: Record<string, any>; version?: string };

/** Add a catalog: clone it into ~/.amness/catalogs/<name> and read its marketplace.json. */
export function addCatalog(url: string): { catalog: Catalog; entries: CatalogEntry[] } {
  const f = fetchExtension(/^(https?:|git@)/.test(url) || (SHORTHAND.test(url) && !existsSync(resolve(url))) ? { source: "url", url: repoUrl(url) } : url);
  try {
    const m = readJson(join(f.dir, ".claude-plugin", "marketplace.json"));
    if (!m || !Array.isArray(m.plugins)) throw new Error(`${url} has no .claude-plugin/marketplace.json with a plugins list`);
    const name = String(m.name ?? basename(f.dir)).replace(/[^\w.-]+/g, "-");
    rmSync(catalogClone(name), { recursive: true, force: true }); mkdirSync(dirname(catalogClone(name)), { recursive: true }); cpSync(f.dir, catalogClone(name), { recursive: true });
    const catalog = { name, url, added: new Date().toISOString() };
    writeJson(catalogFile(), { catalogs: [...listCatalogs().filter((c) => c.name !== name), catalog] });
    return { catalog, entries: catalogEntries(name) };
  } finally { f.cleanup(); }
}
export function removeCatalog(name: string): boolean {
  const left = listCatalogs().filter((c) => c.name !== name); if (left.length === listCatalogs().length) return false;
  writeJson(catalogFile(), { catalogs: left }); rmSync(catalogClone(name), { recursive: true, force: true }); return true;
}
/** Fetch the catalogs again (their plugin lists change). Returns problems, one line each. */
export function refreshCatalogs(): string[] { const bad: string[] = []; for (const c of listCatalogs()) { try { addCatalog(c.url); } catch (e) { bad.push(`${c.name}: ${(e as Error).message}`); } } return bad; }
/** The plugins a catalog lists (or every added catalog's). */
export function catalogEntries(name?: string): CatalogEntry[] {
  return listCatalogs().filter((c) => !name || c.name === name).flatMap((c) => {
    const m = readJson(join(catalogClone(c.name), ".claude-plugin", "marketplace.json"));
    return (Array.isArray(m?.plugins) ? m.plugins : []).filter((p: any) => p && typeof p.name === "string" && p.source !== undefined)
      .map((p: any) => ({ name: p.name, description: String(p.description ?? ""), catalog: c.name, source: p.source, entry: p, version: p.version }));
  });
}
/** Get a catalog entry onto disk: a path is inside the catalog's clone, anything else is fetched. */
export function fetchEntry(e: CatalogEntry): Fetched {
  const root = catalogClone(e.catalog);
  if (typeof e.source === "string") return fetchExtension({ source: "path", path: e.source }, { base: root });
  if (e.source.source === "path") return fetchExtension(e.source, { base: root });
  return fetchExtension(e.source);
}

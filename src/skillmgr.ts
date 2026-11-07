// Managing skills while Amness runs: which ones are in use, turning them on and off, adding and removing them, picking the most relevant ones for a task, and drafting new ones from finished work.
// Skills are instructions the model reads, so anything that arrives from outside (a folder, a git repository) is shown to you first and is never switched on by itself.
// Drafts written by the model wait in `.amness/skills-proposed` until you approve them: learning skills from a model's own runs is not an automatic win (EvoClawBench, arXiv 2607.09711, found collapses for some models),
// and task-specific skills beat personal-preference ones (arXiv 2608.10319), so a human decides what becomes active.
// Folder format: the open Agent Skills layout (a folder with SKILL.md; front matter `name` and `description`, optional `license`, `compatibility`, `allowed-tools`; helper files beside it).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Model } from "./harness.ts";
import { words } from "./plancache.ts";
import { slash } from "./shell.ts";
import type { Skill } from "./skills.ts";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILES = 200, MAX_BYTES = 2_000_000;

// ---------------------------------------------------------------- state: on/off and usage
export type SkillStats = { /** times the model loaded it */ loaded: number; /** times it was listed in a prompt */ offered: number; /** runs that finished after loading it */ finished: number; /** runs that did not */ failed: number; last?: string };

/** Per-project state in `.amness/skills-state.json`: which skills are switched off, and how often each was offered, loaded and followed by a finished run. */
export class SkillState {
  private file: string; disabled = new Set<string>(); stats: Record<string, SkillStats> = {};
  constructor(cwd: string) {
    this.file = join(cwd, ".amness", "skills-state.json");
    try { const j = JSON.parse(readFileSync(this.file, "utf8")); this.disabled = new Set(j.disabled ?? []); this.stats = j.stats ?? {}; } catch { /* first use, or a damaged file: start empty */ }
  }
  isOff(name: string) { return this.disabled.has(name); }
  setOff(name: string, off: boolean) { off ? this.disabled.add(name) : this.disabled.delete(name); this.save(); }
  private s(name: string): SkillStats { return (this.stats[name] ??= { loaded: 0, offered: 0, finished: 0, failed: 0 }); }
  loaded(name: string) { const s = this.s(name); s.loaded++; s.last = new Date().toISOString(); this.save(); }
  offered(names: string[]) { for (const n of names) this.s(n).offered++; if (names.length) this.save(); }
  outcome(names: string[], finished: boolean) { for (const n of names) finished ? this.s(n).finished++ : this.s(n).failed++; if (names.length) this.save(); }
  forget(name: string) { this.disabled.delete(name); delete this.stats[name]; this.save(); }
  save() { try { mkdirSync(join(this.file, ".."), { recursive: true }); writeFileSync(this.file, JSON.stringify({ disabled: [...this.disabled], stats: this.stats }, null, 1)); } catch { /* a read-only folder: state lives for this run only */ } }
}

// ---------------------------------------------------------------- choosing which skills to list
/** The skills most relevant to a task, best first (word overlap with name and description; a skill that finished runs when used gets a small boost). With few skills, all of them. */
export function rankSkills(skills: Skill[], task: string, k = 8, stats: Record<string, SkillStats> = {}): Skill[] {
  if (skills.length <= k) return skills;
  const t = new Set(words(task));
  const score = (s: Skill) => { const w = words(`${s.name.replace(/-/g, " ")} ${s.description}`); const hit = w.filter((x) => t.has(x)).length; const st = stats[s.name]; return hit + (hit && st ? Math.min(1, st.finished / 5) : 0) + (t.has(s.name) ? 2 : 0); };
  const ranked = skills.map((s) => ({ s, sc: score(s) })).sort((a, b) => b.sc - a.sc || (stats[b.s.name]?.loaded ?? 0) - (stats[a.s.name]?.loaded ?? 0) || a.s.name.localeCompare(b.s.name));
  const hits = ranked.filter((x) => x.sc > 0).slice(0, k);
  return (hits.length ? hits : ranked.slice(0, Math.min(k, 3))).map((x) => x.s);
}

// ---------------------------------------------------------------- checking and reading a skill folder
export type Found = { name: string; description: string; dir: string; files: string[]; scripts: string[]; problems: string[] };
const front = (text: string) => { const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); const meta: Record<string, string> = {}; if (m) for (const l of m[1].split(/\r?\n/)) { const kv = /^([\w-]+):\s*(.*)$/.exec(l); if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim(); } return meta; };

/** Every file under `dir`, relative to `base`, with "/" between folders on every system (the list is shown to people and to the model). */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) { if (e === ".git") continue; const p = join(dir, e), st = lstatSync(p); if (st.isSymbolicLink()) { out.push(`${slash(p.slice(base.length + 1))} (symbolic link)`); continue; } if (st.isDirectory()) walk(p, base, out); else out.push(slash(p.slice(base.length + 1))); }
  return out;
}

/** What is in a folder that is a skill, or that holds skills one level down. Problems are listed, never thrown. */
export function inspectSource(src: string): Found[] {
  const dirs = existsSync(join(src, "SKILL.md")) ? [src] : readdirSync(src).map((e) => join(src, e)).filter((d) => { try { return statSync(d).isDirectory() && existsSync(join(d, "SKILL.md")); } catch { return false; } });
  return dirs.map((dir) => {
    const files = walk(dir), problems: string[] = [], meta = front(readFileSync(join(dir, "SKILL.md"), "utf8")), name = (meta.name || basename(dir)).trim();
    if (!SKILL_NAME.test(name)) problems.push(`"${name}" is not a valid skill name (lowercase letters, numbers and hyphens, at most 64)`);
    if (!meta.description) problems.push("it has no description: line in its front matter");
    else if (meta.description.length > 1024) problems.push("the description is longer than 1024 characters");
    if (files.length > MAX_FILES) problems.push(`it has ${files.length} files (limit ${MAX_FILES})`);
    if (files.some((f) => f.includes("(symbolic link)"))) problems.push("it contains symbolic links");
    let bytes = 0; try { bytes = files.filter((f) => !f.includes("(")).reduce((n, f) => n + statSync(join(dir, f)).size, 0); } catch { /* ignore */ } if (bytes > MAX_BYTES) problems.push(`it is ${Math.round(bytes / 1e6)} MB (limit 2 MB)`);
    return { name, description: meta.description ?? "", dir, files, scripts: files.filter((f) => /\.(sh|bash|zsh|py|js|mjs|ts|rb|pl|ps1|bat|cmd)$/i.test(f)), problems };
  });
}

// ---------------------------------------------------------------- adding, creating, removing
/** The folder skills of a scope live in. */
export function skillsDir(cwd: string, scope: "project" | "user"): string {
  return scope === "project" ? join(cwd, ".amness", "skills") : join(process.env.AMNESS_HOME ? resolve(process.env.AMNESS_HOME, "..") : homedir(), ".amness", "skills");
}

/** A new skill from a template. The description is the part that decides when the model loads it, so the template says so. */
export function scaffoldSkill(cwd: string, name: string, description?: string, scope: "project" | "user" = "project"): { dir: string; file: string } {
  if (!SKILL_NAME.test(name)) throw new Error(`"${name}" is not a valid skill name: use lowercase letters, numbers and hyphens (for example release-notes)`);
  const dir = join(skillsDir(cwd, scope), name); if (existsSync(dir)) throw new Error(`a skill named ${name} already exists in ${dir}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description ?? "Use when <the situation in which this skill applies>. It covers <what it tells you to do>."}\n---\n\n# ${name}\n\nWhen to use: say in one or two lines when this skill applies.\n\n## Steps\n\n1. First step, as a command or a concrete action.\n2. Second step.\n\n## Check\n\nHow to tell it worked (a command to run and what it should print).\n\n## Gotchas\n\n- Things that went wrong before.\n`);
  return { dir, file };
}

/** Copy checked skills into a scope. A skill with problems, or one that already exists (without `force`), is skipped and said so. Nothing is switched on beyond being in the folder: it still shows in /skills. */
export function installSkills(cwd: string, found: Found[], o: { scope?: "project" | "user"; force?: boolean } = {}): { installed: string[]; skipped: string[] } {
  const base = skillsDir(cwd, o.scope ?? "project"), installed: string[] = [], skipped: string[] = [];
  for (const f of found) {
    if (f.problems.length) { skipped.push(`${f.name}: ${f.problems.join("; ")}`); continue; }
    const to = join(base, f.name);
    if (existsSync(to) && !o.force) { skipped.push(`${f.name}: already installed (use force to replace)`); continue; }
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    mkdirSync(base, { recursive: true }); cpSync(f.dir, to, { recursive: true, filter: (p) => basename(p) !== ".git" }); installed.push(f.name);
  }
  return { installed, skipped };
}

/** Get a skill source onto disk: a local folder as it is, or a git URL cloned (shallow) into a temporary folder. `https://github.com/owner/repo/tree/branch/path` picks the subfolder. */
export function fetchSource(src: string): { dir: string; cleanup: () => void } {
  if (!/^https?:\/\//.test(src) && !src.startsWith("git@")) { const dir = resolve(src); if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${src} is not a folder`); return { dir, cleanup: () => {} }; }
  const tree = /^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/tree\/([^/]+)\/(.+)$/.exec(src), repo = tree ? tree[1] + ".git" : src, branch = tree?.[2], sub = tree?.[3];
  const tmp = mkdtempSync(join(tmpdir(), "amness-skill-")), clone = join(tmp, "repo");
  const r = spawnSync("git", ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), "--", repo, clone], { encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`git clone failed: ${(r.stderr || r.error?.message || "unknown error").trim().split("\n").pop()}`); }
  const dir = sub ? resolve(clone, sub) : clone; if (!dir.startsWith(clone)) { rmSync(tmp, { recursive: true, force: true }); throw new Error("that path leaves the repository"); }
  return { dir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** Take a skill out of use without losing it: its folder moves to `.amness/skills-trash`. */
export function trashSkill(cwd: string, skill: Skill): string {
  const to = join(cwd, ".amness", "skills-trash", `${skill.name}-${Date.now().toString(36)}`);
  mkdirSync(join(to, ".."), { recursive: true }); renameSync(skill.dir, to); return to;
}

// ---------------------------------------------------------------- drafts from finished work (a person approves them)
const proposedDir = (cwd: string) => join(cwd, ".amness", "skills-proposed");
export type Draft = { name: string; description: string; dir: string; file: string };

export function listDrafts(cwd: string): Draft[] {
  const base = proposedDir(cwd); if (!existsSync(base)) return [];
  return readdirSync(base).map((e) => join(base, e, "SKILL.md")).filter(existsSync).map((file) => { const meta = front(readFileSync(file, "utf8")); const dir = join(file, ".."); return { name: meta.name || basename(dir), description: meta.description ?? "", dir, file }; });
}

const DRAFT_PROMPT = `Write a reusable skill from the work above, for a future agent that gets a similar task. Reply with the skill file only, in this exact shape:
---
name: a-short-lowercase-hyphenated-name
description: One line that says WHEN to use this skill (the situation and the kind of task), not what this one task was.
---
# Title
## Steps
numbered, concrete steps (commands, file conventions, the order that worked)
## Check
how to tell it worked
## Gotchas
what went wrong or surprised you
Keep only what carries over to other tasks. No names of this task's particular files unless they are conventions of the project. Under 40 lines.`;

/** Ask the model to turn a finished conversation into a skill, and store it as a draft. Nothing becomes active until `approveDraft`. */
export async function draftSkill(cwd: string, model: Model, messages: Parameters<Model>[0]): Promise<Draft> {
  const reply = await model([...messages, { role: "user", content: DRAFT_PROMPT }], []);
  let text = (reply.content ?? "").trim().replace(/^```(?:markdown|md)?\n?/, "").replace(/\n?```$/, "");
  const meta = front(text); if (!meta.name || !meta.description) throw new Error("the model did not write a skill in the expected shape (name and description lines): nothing was saved");
  const name = meta.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); if (!SKILL_NAME.test(name)) throw new Error(`the model chose an unusable name: ${meta.name}`);
  text = text.replace(/^(---\r?\n[\s\S]*?\bname:\s*).*$/m, `$1${name}`);
  const dir = join(proposedDir(cwd), name); mkdirSync(dir, { recursive: true }); const file = join(dir, "SKILL.md"); writeFileSync(file, text + "\n");
  return { name, description: meta.description, dir, file };
}

export function approveDraft(cwd: string, name: string, scope: "project" | "user" = "project"): string {
  const d = listDrafts(cwd).find((x) => x.name === name); if (!d) throw new Error(`no draft named ${name}`);
  const to = join(skillsDir(cwd, scope), name); if (existsSync(to)) throw new Error(`a skill named ${name} already exists`);
  mkdirSync(skillsDir(cwd, scope), { recursive: true }); renameSync(d.dir, to); return to;
}
export function rejectDraft(cwd: string, name: string): void { const d = listDrafts(cwd).find((x) => x.name === name); if (!d) throw new Error(`no draft named ${name}`); rmSync(d.dir, { recursive: true, force: true }); }

// `amness skills`: manage skills without opening the chat. Same functions as /skills in the chat.
import { readFileSync } from "node:fs";
import { inspectSource, installSkills, fetchSource, loadSkills, scaffoldSkill, SkillState, trashSkill, listDrafts, approveDraft, rejectDraft } from "../src/index.ts";
import { dim, green, red, yellow } from "./ui.ts";

export const SKILLS_HELP = `usage: amness skills <command>
  list                       every skill, which are switched off, how often each was used here, and drafts waiting for approval
  show <name>                print a skill's instructions
  new <name> [description]   create .amness/skills/<name>/SKILL.md from a template
  add <folder|git-url> [--user] [--yes] [--force]   install skills from a folder or a git repository (https://github.com/owner/repo/tree/branch/path works); shows what it found, asks first
  remove <name>              move a skill to .amness/skills-trash (reversible)
  on <name> | off <name>     switch a skill on or off for this project
  approve <name> | reject <name>   decide about a draft written by /skills draft in the chat
A skill is a set of instructions the model follows. Read a skill before you use it, and do not install skills you do not trust.`;

export async function runSkills(argv: string[], deps: { cwd?: string; confirm?: (q: string) => Promise<boolean> } = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd(), [sub = "list", ...rest] = argv.filter((a) => !a.startsWith("--")), flag = (f: string) => argv.includes(f), name = rest[0];
  if (argv.includes("--help") || sub === "help") { console.log(SKILLS_HELP); return 0; }
  const state = new SkillState(cwd), all = () => loadSkills(cwd).skills, find = (n?: string) => all().find((s) => s.name === n);
  try {
    if (sub === "list" || sub === "ls") {
      const { skills, warnings } = loadSkills(cwd), drafts = listDrafts(cwd);
      if (!skills.length) console.log(dim("no skills yet. amness skills new <name> makes one; amness skills add <folder or git URL> installs one."));
      for (const s of skills) { const k = state.stats[s.name], off = state.isOff(s.name); console.log(`${off ? dim("⊘") : "○"} ${s.name.padEnd(22)} ${dim(`[${s.scope} · ${s.source}]`)}${off ? dim(" off") : ""}${k?.loaded ? dim(` · used ${k.loaded}×${k.finished || k.failed ? `, runs: ${k.finished} finished, ${k.failed} stopped` : ""}`) : ""}\n    ${dim(s.description)}`); }
      for (const d of drafts) console.log(`${yellow("draft")} ${d.name.padEnd(20)} ${dim(d.description)}`);
      for (const w of warnings) console.log(dim(w));
      return 0;
    }
    if (sub === "show") { const s = find(name); if (!s) { console.error(red(name ? `no skill named ${name}` : "usage: amness skills show <name>")); return 2; } console.log(readFileSync(s.file, "utf8")); return 0; }
    if (sub === "new") { const r = scaffoldSkill(cwd, name ?? "", rest.slice(1).join(" ") || undefined); console.log(green("created ") + r.file + dim("\nedit it: the description line decides when the model loads it."));  return 0; }
    if (sub === "on" || sub === "off") { const s = find(name); if (!s) { console.error(red(name ? `no skill named ${name}` : `usage: amness skills ${sub} <name>`)); return 2; } state.setOff(s.name, sub === "off"); console.log(`${s.name} ${sub === "off" ? "switched off" : "on again"}`); return 0; }
    if (sub === "remove" || sub === "rm") { const s = find(name); if (!s) { console.error(red(name ? `no skill named ${name}` : "usage: amness skills remove <name>")); return 2; } const to = trashSkill(cwd, s); state.forget(s.name); console.log(`removed ${s.name}; kept at ${to}`); return 0; }
    if (sub === "approve") { if (!name) { console.error(red("usage: amness skills approve <name>")); return 2; } approveDraft(cwd, name); console.log(`${name} is active`); return 0; }
    if (sub === "reject") { if (!name) { console.error(red("usage: amness skills reject <name>")); return 2; } rejectDraft(cwd, name); console.log(`${name} deleted`); return 0; }
    if (sub === "add" || sub === "install") {
      if (!name) { console.error(red("usage: amness skills add <folder or git URL> [--user] [--yes] [--force]")); return 2; }
      const src = fetchSource(name);
      try {
        const found = inspectSource(src.dir); if (!found.length) { console.error(red(`no SKILL.md found in ${name} (or one folder down)`)); return 1; }
        for (const f of found) console.log(`${f.problems.length ? red("✗") : green("✓")} ${f.name} ${dim(`${f.files.length} files`)}${f.scripts.length ? yellow(`  includes scripts: ${f.scripts.slice(0, 4).join(", ")}`) : ""}\n    ${dim(f.description || "(no description)")}${f.problems.map((p) => "\n    " + red(p)).join("")}`);
        const ok = flag("--yes") || (deps.confirm ? await deps.confirm(`Install ${found.filter((f) => !f.problems.length).length} skill(s) for ${flag("--user") ? "all your projects" : "this project"}? A skill is instructions the model will follow.`) : false);
        if (!ok) { console.log(dim(flag("--yes") ? "" : "not installed (pass --yes to install without asking)")); return 1; }
        const r = installSkills(cwd, found, { scope: flag("--user") ? "user" : "project", force: flag("--force") });
        console.log(r.installed.length ? green(`installed: ${r.installed.join(", ")}`) : "nothing installed"); for (const s of r.skipped) console.log(dim("skipped: " + s)); return r.installed.length ? 0 : 1;
      } finally { src.cleanup(); }
    }
    console.error(red(`unknown command: ${sub}`) + "\n" + SKILLS_HELP); return 2;
  } catch (e) { console.error(red((e as Error).message)); return 1; }
}

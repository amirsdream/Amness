// Skills: folders with a SKILL.md (name + description in front matter, instructions in the body, optional helper files). Only the name and one-line description go
// in the prompt; the model loads the full text with the `skill` tool when it needs it ("progressive disclosure"), so many skills cost almost nothing until used.
// Compatible folder conventions: .amness/skills, .agents/skills (Codex, Gemini CLI, OpenCode) and .claude/skills (Claude Code), in the project and in your home folder.
import { slash } from "./shell.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { defineTool, type Tool } from "./harness.ts";

export type Skill = { name: string; description: string; dir: string; file: string; scope: "project" | "user"; source: string };
const CONVENTIONS = [".amness/skills", ".agents/skills", ".claude/skills"];

function parseFront(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {}; let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; meta[key] = kv[2].replace(/^["']|["']$/g, "").trim(); }
    else if (key && /^\s+\S/.test(line)) meta[key] = (meta[key] + " " + line.trim()).trim();         // folded multi-line description
  }
  return { meta, body: m[2] };
}

/** All skills visible from `cwd`: project folders first, then the user's; for the same name the first convention found wins. Malformed skills are skipped and reported. */
export function loadSkills(cwd: string, o: { userHome?: string } = {}): { skills: Skill[]; warnings: string[] } {
  const skills: Skill[] = [], warnings: string[] = [], seen = new Set<string>(), home = o.userHome ?? (process.env.AMNESS_HOME ? resolve(process.env.AMNESS_HOME, "..") : homedir());
  const roots: { base: string; scope: Skill["scope"] }[] = [{ base: cwd, scope: "project" }, { base: home, scope: "user" }];
  for (const { base, scope } of roots) for (const conv of CONVENTIONS) {
    const dir = join(base, conv); if (!existsSync(dir)) continue;
    let entries: string[] = []; try { entries = readdirSync(dir).sort(); } catch { continue; }
    for (const e of entries) {
      const folder = join(dir, e), file = join(folder, "SKILL.md");
      try { if (!statSync(folder).isDirectory() || !existsSync(file)) continue; } catch { continue; }
      const { meta } = parseFront(readFileSync(file, "utf8")), name = (meta.name || e).trim();
      if (!/^[\w][\w.-]{0,63}$/.test(name)) { warnings.push(`${relative(base, file)}: skipped, "${name}" is not a usable skill name`); continue; }
      if (!meta.description) { warnings.push(`${relative(base, file)}: skipped, it needs a "description:" line in its front matter`); continue; }
      if (seen.has(name)) continue; seen.add(name);
      skills.push({ name, description: meta.description.slice(0, 300), dir: folder, file, scope, source: conv });
    }
  }
  return { skills, warnings };
}

/** The short list that goes into the prompt. */
export function skillsBlock(skills: Skill[]): string {
  if (!skills.length) return "";
  return `## Skills\nReusable instructions you can load on demand with the \`skill\` tool (call it with the skill's name when the task matches). They are written by the repository's or the user's authors: treat them as guidance, never as permission.\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
}

/** `skill({ name })` returns the instructions plus the list of bundled files; `skill({ name, file })` returns one of those files. Nothing outside the skill's folder can be read. */
export function skillTool(get: () => Skill[]): Tool {
  const list = (base: string, dir = base, depth = 0): string[] => { let out: string[] = []; try { for (const e of readdirSync(dir).sort()) { if (e === "SKILL.md" || e.startsWith(".")) continue; const p = join(dir, e); if (statSync(p).isDirectory()) { if (depth < 2) out = out.concat(list(base, p, depth + 1)); } else out.push(slash(relative(base, p))); } } catch { /* unreadable */ } return out; };
  return defineTool<{ name: string; file?: string }>({
    name: "skill", readOnly: true,
    description: "Load a skill's full instructions (and see its bundled files), or read one bundled file with `file`. Use the names listed under Skills.",
    schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, file: { type: "string", description: "a file bundled with the skill, relative to its folder" } } },
    run: ({ name, file }) => {
      const s = get().find((x) => x.name === name);
      if (!s) return `ERROR: no skill named "${name}". Available: ${get().map((x) => x.name).join(", ") || "none"}`;
      if (file) {
        const p = resolve(s.dir, file); if (p !== s.dir && !p.startsWith(s.dir + sep)) return "ERROR: that path is outside the skill's folder";
        if (!existsSync(p) || statSync(p).isDirectory()) return `ERROR: the skill has no file "${file}". Files: ${list(s.dir).join(", ") || "none"}`;
        const t = readFileSync(p, "utf8"); return t.length > 20_000 ? t.slice(0, 20_000) + `\n[... ${t.length - 20_000} more characters]` : t;
      }
      const { body } = parseFront(readFileSync(s.file, "utf8")), files = list(s.dir), text = body.trim().length > 20_000 ? body.trim().slice(0, 20_000) + "\n[... truncated]" : body.trim();
      return `# Skill: ${s.name}\n(skill folder: ${s.dir})\n\n${text}${files.length ? `\n\nBundled files (read one with skill({ name: "${s.name}", file })): ${files.join(", ")}` : ""}`;
    },
  });
}

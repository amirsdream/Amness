// Custom subagents: a markdown file per agent (front matter + the agent's system prompt), in .amness/agents/ or .claude/agents/ (project and home).
//   ---
//   name: reviewer
//   description: reviews diffs for bugs
//   tools: read_file, grep, list_files          (default: the read-only set)
//   model: fast                                  (a key of the `agentModels` option; default: the main model)
//   isolation: worktree                          (a writing agent works in its own git worktree and hands back a diff)
//   max-steps: 20
//   ---
//   You are a careful reviewer. ...
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type AgentDef = { name: string; description: string; tools: string[]; model?: string; isolation?: "worktree"; maxSteps: number; prompt: string; scope: "project" | "user"; source: string; file: string };
export const READ_TOOLS = ["list_files", "read_file", "grep"];
/** Tools an agent definition may name. Everything else (task, background processes, memory) stays with the lead. */
export const AGENT_TOOLS = ["list_files", "read_file", "grep", "write_file", "edit_file", "apply_patch", "sh", "skill"];
export const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "sh"]);

const CONVENTIONS = [".amness/agents", ".claude/agents"];
export function loadAgents(cwd: string, o: { userHome?: string } = {}): { agents: AgentDef[]; warnings: string[] } {
  const agents: AgentDef[] = [], warnings: string[] = [], seen = new Set<string>(["explore"]), home = o.userHome ?? (process.env.AMNESS_HOME ? resolve(process.env.AMNESS_HOME, "..") : homedir());
  for (const [base, scope] of [[cwd, "project"], [home, "user"]] as const) for (const conv of CONVENTIONS) {
    const dir = join(base, conv); if (!existsSync(dir)) continue;
    let files: string[] = []; try { files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8"), m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
      if (!m) { warnings.push(`${conv}/${f}: skipped, it needs front matter with a name and description`); continue; }
      const meta: Record<string, string> = {}; for (const line of m[1].split(/\r?\n/)) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim(); }
      const name = (meta.name || f.replace(/\.md$/, "")).trim();
      if (!/^[\w][\w.-]{0,40}$/.test(name)) { warnings.push(`${conv}/${f}: skipped, "${name}" is not a usable agent name`); continue; }
      if (!meta.description) { warnings.push(`${conv}/${f}: skipped, it needs a "description:" line`); continue; }
      if (seen.has(name)) { if (name === "explore") warnings.push(`${conv}/${f}: "explore" is built in; pick another name`); continue; } seen.add(name);
      const asked = (meta.tools ? meta.tools.split(/[,\s]+/).filter(Boolean) : READ_TOOLS), tools = asked.filter((t) => AGENT_TOOLS.includes(t));
      for (const t of asked) if (!AGENT_TOOLS.includes(t)) warnings.push(`${conv}/${f}: tool "${t}" is not available to subagents (allowed: ${AGENT_TOOLS.join(", ")})`);
      if (!/\b(report|return|summar|answer|finish)/i.test(m[2])) warnings.push(`${conv}/${f}: advice: say what the agent should report back (a short summary with file paths); subagents that do not know tend to ramble or stop without an answer`);
      agents.push({ name, description: meta.description.slice(0, 200), tools: tools.length ? tools : READ_TOOLS, model: meta.model || undefined, isolation: meta.isolation === "worktree" ? "worktree" : undefined, maxSteps: Math.min(60, Math.max(3, Number(meta["max-steps"]) || 20)), prompt: m[2].trim(), scope, source: conv, file: join(dir, f) });
    }
  }
  return { agents, warnings };
}
export const isWriter = (a: Pick<AgentDef, "tools">) => a.tools.some((t) => WRITE_TOOLS.has(t));

// User-defined slash commands: every <name>.md in .amness/commands (project) or ~/.amness/commands (user) becomes /<name>.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Cmd } from "./commands.ts";

export function parseCommandFile(raw: string, fallback: string): { description: string; body: string } {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = (fm ? fm[2] : raw).trim();
  const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim() ?? body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 70) ?? fallback;
  return { description: desc, body };
}

export function loadCustomCommands(dirs: { dir: string; scope: "project" | "user" }[]): Cmd[] {
  const out = new Map<string, Cmd>();
  for (const { dir, scope } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".md")) continue;
      const name = basename(f, ".md").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      if (!name || (out.has(name) && scope === "user")) continue;                 // a project command overrides a user command of the same name
      let parsed; try { parsed = parseCommandFile(readFileSync(join(dir, f), "utf8"), name); } catch { continue; }
      const { description, body } = parsed;
      out.set(name, { name, help: `${description} (${scope})`, args: "[args]",
        run: (app, args) => app.turn(body.includes("$ARGUMENTS") ? body.split("$ARGUMENTS").join(args) : args ? `${body}\n\n${args}` : body) });
    }
  }
  return [...out.values()];
}

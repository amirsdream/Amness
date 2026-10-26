import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export type Attached = { path: string; lines: number; dir?: boolean };

/** Turn `@path` mentions into attached file contents (the typed text stays as written). Only paths inside `cwd` are read. */
export function expandMentions(text: string, cwd: string, maxChars = 40_000): { text: string; attached: Attached[] } {
  const root = resolve(cwd), attached: Attached[] = [], blocks: string[] = [], seen = new Set<string>();
  for (const m of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const rel = m[2].replace(/[.,;:!?)\]]+$/, "");
    if (seen.has(rel)) continue; seen.add(rel);
    const abs = resolve(root, rel);
    if ((abs !== root && !abs.startsWith(root + sep)) || !existsSync(abs)) continue;
    try {
      if (statSync(abs).isDirectory()) {
        const names = readdirSync(abs).sort().slice(0, 80);
        blocks.push(`<directory path="${rel}">\n${names.join("\n")}\n</directory>`); attached.push({ path: rel, lines: names.length, dir: true });
      } else {
        const raw = readFileSync(abs, "utf8");
        if (raw.includes("\0")) continue;
        const body = raw.length > maxChars ? raw.slice(0, maxChars) + `\n… [truncated: ${raw.length - maxChars} more characters; use read_file for the rest]` : raw;
        blocks.push(`<file path="${rel}">\n${body}\n</file>`); attached.push({ path: rel, lines: raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0) });
      }
    } catch { /* unreadable: leave the mention as plain text */ }
  }
  return { text: blocks.length ? `${text}\n\n<attached>\n${blocks.join("\n")}\n</attached>` : text, attached };
}

export const attachedNote = (a: Attached[]) => (a.length ? "attached " + a.map((x) => `${x.path} (${x.dir ? `${x.lines} entr${x.lines === 1 ? "y" : "ies"}` : `${x.lines} line${x.lines === 1 ? "" : "s"}`})`).join(", ") : "");

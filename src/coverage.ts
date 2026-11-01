// "Read each file" means each file. A small model tends to read a few, guess the rest from their names, and report success (seen on a local Qwen: 3 of 32 files read, 32 described).
// This check runs when the model tries to finish. If the task asked for every file to be read, and the file list the agent itself printed shows files it never opened, the finish is refused with the names of the unread ones.
// It only looks at what happened (calls and their arguments), never at what the model says. It stays silent when it cannot tell: no file list in the transcript, or the history was replaced by a handoff.
import type { Message } from "./harness.ts";

/** A task that asks for every file to be looked at: "read each file in src", "go through all the files", "document every file". */
export const WANTS_ALL = /\b(read|open|go through|go over|review|look at|inspect|examine|check|document|summari[sz]e|describe)\b[^.\n]{0,60}\b(each|every|all(?: of)?(?: the)?)\b[^.\n]{0,40}\bfiles?\b/i;
const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

export type Coverage = { listed: string[]; read: string[]; missing: string[] };

/** What the transcript shows: the files a listing printed, the files read, and the listed files never read. Undefined when it cannot tell. */
export function coverage(task: string, messages: Message[]): Coverage | undefined {
  task = task.split("\n\n## ")[0];                                                       // only the user's own words: not the memory, skills or guidance blocks added after them
  if (!WANTS_ALL.test(task)) return undefined;
  if (messages.some((m) => m.role === "user" && (m.content ?? "").includes("## Handoff from your earlier context"))) return undefined;   // the history was replaced: we cannot see what was read
  const calls = new Map<string, { name: string; path: string }>();
  for (const m of messages) for (const c of m.tool_calls ?? []) { try { const a = JSON.parse(c.function.arguments || "{}"); calls.set(c.id, { name: c.function.name, path: typeof a.path === "string" ? norm(a.path) : "" }); } catch { /* skip */ } }
  const listings: { dir: string; files: string[] }[] = [], read = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || !m.tool_call_id) continue; const c = calls.get(m.tool_call_id); if (!c || /^(ERROR|DENIED)/.test(m.content ?? "")) continue;
    if (c.name === "read_file") read.add(c.path);
    else if (c.name === "list_files" && (m.content ?? "") && !m.content!.startsWith("[")) {
      const files = m.content!.split("\n").map((l) => l.trim()).filter((l) => l && !/\s/.test(l) && /[./]/.test(l) && !l.startsWith("[") && !l.startsWith("..."));
      if (files.length) listings.push({ dir: c.path, files: files.map(norm) });
    }
  }
  const t = task.replace(/\\/g, "/");
  const named = listings.filter((l) => l.dir && l.dir !== "." && t.includes(l.dir)).sort((x, y) => y.dir.length - x.dir.length)[0];
  const pick = named ?? listings.at(-1);                                                // the listing of the (most specific) folder the task names, else the latest
  if (!pick || pick.files.length < 3) return undefined;
  const files = pick.files.filter((f) => !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f));
  return { listed: files, read: files.filter((f) => read.has(f)), missing: files.filter((f) => !read.has(f)) };
}

/** The message that sends the agent back to read, or undefined when it did enough. A few unread files (10%) are tolerated: listings include odd ones. */
export function coverageCheck(ctx: { task: string; messages: Message[] }): string | undefined {
  const c = coverage(ctx.task, ctx.messages); if (!c) return undefined;
  if (c.missing.length <= Math.floor(c.listed.length * 0.1)) return undefined;
  const names = c.missing.slice(0, 10).join(", ") + (c.missing.length > 10 ? `, and ${c.missing.length - 10} more` : "");
  return `the task asks you to read each file, but you read ${c.read.length} of the ${c.listed.length} files you listed. Not read: ${names}. Read them (read_file), then finish. Do not describe a file you have not read; if you truly cannot read some, say which in your summary.`;
}

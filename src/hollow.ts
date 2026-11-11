// The `hollow` guard: schema-valid calls can still be empty or placeholders (arXiv 2609.23742, read). In coding, the damaging form is a
// write or edit whose new text elides code: "// ... rest of the code unchanged ...". The file is then silently cut down to the visible part.
// Only unambiguous markers fire: a whole comment line naming elided code, that is new (not already in the file, not in the replaced text).
// False fires are worse than misses, so a bare "..." (valid Python) or the words inside a string literal never fire.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMMENT = String.raw`(?:\/\/+|#+|\/\*+|\*|<!--|--|;+|%)`;
const PHRASE = String.raw`(?:rest of (?:the )?(?:code|file|function|class|method|implementation|component|module|test|tests)|(?:existing|remaining|previous|other|original|unchanged|same) (?:code|methods|functions|logic|implementation|content|tests|imports|lines)|code (?:remains |is )?unchanged|(?:everything|all) else (?:stays|remains|unchanged)|unchanged below|same as before|keep (?:the )?existing)`;
const MARKER = new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.\.\.|…)?\s*[\[(]?\s*${PHRASE}\b.*$`, "im");

/** The first elision marker line in `text`, or undefined. */
export function elisionMarker(text: string): string | undefined {
  for (const line of text.split("\n")) if (MARKER.test(line) && /\.\.\.|…|\b(rest|remaining|unchanged|existing|else|same|keep)\b/i.test(line)) return line.trim().slice(0, 120);
  return undefined;
}

/** Why a write or edit is hollow, or undefined. `cwd` resolves the path, to compare with what the file already holds. */
export function hollowWhy(cwd: string, name: string, args: Record<string, unknown>): string | undefined {
  const blankish = (v: unknown) => typeof v === "string" && /^[\s\p{P}\d]*$/u.test(v) && !/[\p{L}]/u.test(v);
  if ((name === "write_file" || name === "edit_file") && blankish(args.path)) return `the path ${JSON.stringify(args.path)} is empty or only punctuation or numbering`;
  const current = (() => { try { const p = resolve(cwd, String(args.path ?? "")); return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; } })();
  const fresh = (text: string, before: string) => { const mk = elisionMarker(text); return mk && !before.includes(mk) ? mk : undefined; };
  let mk: string | undefined;
  if (name === "write_file" && typeof args.content === "string") mk = fresh(args.content, current);
  else if (name === "edit_file") {
    const edits = Array.isArray(args.edits) ? (args.edits as { old?: string; new?: string }[]) : [{ old: args.old as string, new: args.new as string }];
    for (const e of edits) if (typeof e?.new === "string") { mk = fresh(e.new, `${e.old ?? ""}\n${current}`); if (mk) break; }
  } else if (name === "apply_patch" && typeof args.patch === "string") {
    const added = args.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n"), removed = args.patch.split("\n").filter((l) => l.startsWith("-")).map((l) => l.slice(1)).join("\n");
    mk = fresh(added, removed);
  }
  return mk ? `the new text leaves code out with a placeholder line ("${mk}"); the file would lose everything that line stands for` : undefined;
}

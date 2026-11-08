// A finish check against "building to the test" (arXiv 2606.28430): with tests to satisfy, agents can make the tests pass while the real deliverable stays
// unused, the tested behaviour living in a demo or a copy. A cheap, grounded signal of that: source files the agent created that nothing imports.
// The check refuses the first finish and names them, so the agent connects them, or says in its summary that they stand alone and finishes again.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CodeIndex } from "./codeindex.ts";
import type { Message } from "./harness.ts";

/** Only languages whose relative imports the code index resolves to files; elsewhere "nothing imports it" would be noise. */
const JUDGED = new Set(["ts", "js", "py"]);
const SKIP = /(^|\/)(tests?|__tests__|spec|specs|e2e|examples?|demos?|samples?|scripts?|bin|docs?|fixtures?|migrations?|\.github)\//i;
const SKIP_NAME = /([._-](test|spec|e2e|demo|example|stories|config|conf|setup))\.[a-z]+$|^(index|main|cli|app|server|__main__|__init__|manage|setup|conftest|vite\.config|jest\.config|vitest\.config)\.[a-z]+$/i;

/** Paths package.json names as entry points (main, module, bin, exports), relative and without "./". */
function entries(root: string): Set<string> {
  const out = new Set<string>();
  try {
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const add = (v: unknown) => { if (typeof v === "string") out.add(v.replace(/^\.\//, "")); else if (v && typeof v === "object") for (const x of Object.values(v)) add(x); };
    add(pj.main); add(pj.module); add(pj.bin); add(pj.exports);
  } catch { /* no package.json */ }
  return out;
}

/** A file meant to be imported: in TS/JS it exports something; in Python it only defines (functions, classes, constants) and runs nothing at the top level. */
function isModule(lang: string, text: string): boolean {
  if (lang === "ts" || lang === "js") return /^\s*export\s|\bmodule\.exports\b|\bexports\.\w+\s*=/m.test(text);
  const top = text.split("\n").filter((l) => /^\S/.test(l) && !/^(#|@|def |class |async def |import |from |"""|\'\'\'|[A-Za-z_][\w]*\s*(:[^=]+)?=|if TYPE_CHECKING|try:|except|else:|finally:|\))/.test(l));
  return /^(def |class |async def )/m.test(text) && top.length === 0;
}

/** The created source files nothing imports, after the exceptions (tests, demos, entry points, scripts with a main guard, files the task names). */
export function unusedNewFiles(root: string, index: CodeIndex, created: string[], task: string): string[] {
  try { index.refresh(); } catch { return []; }
  const ep = entries(root);
  return created.filter((p) => {
    const f = index.files.get(p);
    if (!f || !JUDGED.has(f.lang) || SKIP.test(p) || SKIP_NAME.test(basename(p)) || ep.has(p) || task.includes(basename(p))) return false;
    if (!existsSync(join(root, p))) return false;
    const text = readFileSync(join(root, p), "utf8");
    if (/^#!/.test(text) || /if\s+__name__\s*==\s*["']__main__["']/.test(text) || /\bimport\.meta\.main\b|require\.main\s*===\s*module/.test(text)) return false;   // meant to be run
    if (!isModule(f.lang, text)) return false;                                     // a script that runs on its own is not meant to be imported
    return index.importedBy(p).length === 0;
  });
}

/** The finish check (guard `audit`). It refuses once per task: the agent may answer that the files stand alone and finish again. */
export function auditCheck(root: string, index: () => CodeIndex | undefined, created: () => string[]): ((ctx: { task: string; summary: string; messages: Message[] }) => string | undefined) & { guard: "audit" } {
  const asked = new Set<string>();
  const check = (ctx: { task: string }) => {
    const ix = index(); if (!ix || asked.has(ctx.task)) return undefined;
    const files = unusedNewFiles(root, ix, created(), ctx.task); if (!files.length) return undefined;
    asked.add(ctx.task);
    return `nothing imports ${files.length === 1 ? "this new file" : "these new files"}: ${files.slice(0, 8).join(", ")}. If ${files.length === 1 ? "it is" : "they are"} part of the deliverable, connect ${files.length === 1 ? "it" : "them"} to the code that uses ${files.length === 1 ? "it" : "them"} (and make the tests exercise the real code, not a demo or a copy). If ${files.length === 1 ? "it is" : "they are"} meant to stand alone, say so in your summary and finish again.`;
  };
  return Object.assign(check, { guard: "audit" as const });
}

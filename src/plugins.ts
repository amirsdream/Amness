// Plugins: harness behaviour written as code. A plugin is a TypeScript or JavaScript file in `.amness/plugins/` (or `~/.amness/plugins/`) that can add tools, run code at every
// point of the loop (the eight hook events, in-process, with the full payload), rewrite the system prompt, and contribute evaluation tasks, graders and harness variants.
// Everything the built-in guards do can be done from here, and `amness eval` can then compare your harness against the others like any built-in variant.
// A plugin runs with your full permissions, so project plugins load only after you approve that exact set of files (same rule as project hooks).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Case, Variant } from "./evals.ts";
import type { Guard, Model, Tool } from "./harness.ts";
import type { HookEvent, HookResult, HookRunner } from "./hooks.ts";

export type HookReturn = { block?: string; context?: string; args?: Record<string, unknown> } | string | void;
export type HookHandler = (payload: Record<string, unknown> & { event: HookEvent; cwd: string }) => HookReturn | Promise<HookReturn>;
/** A harness variant for `amness eval`, as data (switch guards off, add plugins, change the prompt) or as code (`build` returns the whole Variant). */
export type VariantSpec = {
  off?: Guard[]; maxSteps?: number; /** run with the case's verify command as the finish gate (default true) */ verify?: boolean; review?: boolean;
  /** plugins (by name) active in this variant, in addition to the plugin that defines it */ plugins?: string[];
  system?: (base: string) => string;
  build?: (model: Model, o: { maxSteps?: number; maxTokens?: number }) => Variant;
};
export type Plugin = {
  name: string; description?: string;
  tools?: Tool[];
  hooks?: Partial<Record<HookEvent, HookHandler>>;
  /** a handler that throws blocks instead of warning (for hooks that enforce a rule) */ failClosed?: boolean;
  /** rewrite the system prompt (runs once per conversation start) */ system?: (base: string, ctx: { cwd: string }) => string;
  /** evaluation: tasks with graders written as functions, and harness variants */ cases?: Case[]; variants?: Record<string, VariantSpec>;
};
/** Identity function that gives you types and completion while writing a plugin. */
export const definePlugin = (p: Plugin): Plugin => p;

const EXT = new Set([".ts", ".mts", ".js", ".mjs"]);
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => EXT.has(extname(f)) && statSync(join(dir, f)).isFile()).sort().map((f) => join(dir, f)) : []);
export const projectPluginDir = (cwd: string) => join(cwd, ".amness", "plugins");
/** A fingerprint of the project's plugin files: approval is remembered for exactly this content. */
export function pluginFingerprint(cwd: string): string | undefined {
  const fs = filesIn(projectPluginDir(cwd)); if (!fs.length) return undefined;
  const h = createHash("sha256"); for (const f of fs) h.update(f).update(readFileSync(f)); return h.digest("hex").slice(0, 16);
}

export type Loaded = { plugins: Plugin[]; warnings: string[]; /** project plugins exist but were not loaded because they are not approved */ untrusted?: { count: number; fingerprint: string } };
const valid = (p: any, file: string): string | undefined => {
  if (!p || typeof p !== "object") return `${file}: must export a plugin object (export default definePlugin({ name, ... }))`;
  if (typeof p.name !== "string" || !/^[\w.-]{1,40}$/.test(p.name)) return `${file}: needs a "name" (letters, numbers, . _ -)`;
  for (const k of ["tools", "cases"]) if (p[k] !== undefined && !Array.isArray(p[k])) return `${file}: "${k}" must be a list`;
  if (p.hooks !== undefined && (typeof p.hooks !== "object" || Object.values(p.hooks).some((h) => typeof h !== "function"))) return `${file}: "hooks" must map event names to functions`;
  return undefined;
};
/** Import one plugin file (also used by `amness eval --plugin <file>`, where passing the file is the approval). */
export async function importPlugins(file: string): Promise<{ plugins: Plugin[]; warnings: string[] }> {
  const warnings: string[] = [], plugins: Plugin[] = [];
  try {
    const mod = await import(pathToFileURL(resolve(file)).href + `?v=${Date.now()}`), exp = mod.default ?? mod.plugin ?? mod.plugins;
    for (const p of Array.isArray(exp) ? exp : [exp]) { const bad = valid(p, file); if (bad) warnings.push(bad); else plugins.push(p as Plugin); }
  } catch (e) { warnings.push(`${file}: could not load: ${(e as Error).message.split("\n")[0]}`); }
  return { plugins, warnings };
}
/** User plugins always load; project plugins only when `trustProject`. Problems are warnings, never exceptions: a broken plugin must not stop the agent starting. */
export async function loadPlugins(cwd: string, o: { trustProject?: boolean; userDir?: string } = {}): Promise<Loaded> {
  const out: Loaded = { plugins: [], warnings: [] }, seen = new Set<string>();
  const add = async (files: string[]) => { for (const f of files) { const r = await importPlugins(f); out.warnings.push(...r.warnings); for (const p of r.plugins) { if (seen.has(p.name)) out.warnings.push(`${f}: a plugin named "${p.name}" is already loaded; skipped`); else { seen.add(p.name); out.plugins.push(p); } } } };
  await add(filesIn(join(o.userDir ?? process.env.AMNESS_HOME ?? join(homedir(), ".amness"), "plugins")));
  const proj = filesIn(projectPluginDir(cwd));
  if (proj.length) { if (o.trustProject) await add(proj); else out.untrusted = { count: proj.length, fingerprint: pluginFingerprint(cwd)! }; }
  return out;
}

/** Hooks from plugins, run in-process after the shell hooks. Same rules as shell hooks: the first block stops the rest, context accumulates, the last rewritten args win. */
export function composeHooks(shell: HookRunner | undefined, plugins: Plugin[], cwd: string): HookRunner | undefined {
  const withHooks = plugins.filter((p) => p.hooks && Object.keys(p.hooks).length);
  if (!withHooks.length) return shell;
  return {
    count: () => (shell?.count() ?? 0) + withHooks.reduce((n, p) => n + Object.keys(p.hooks!).length, 0),
    async run(event, payload) {
      const res: HookResult = shell ? await shell.run(event, payload) : { warnings: [] };
      if (res.block) return res;
      for (const p of withHooks) {
        const h = p.hooks![event]; if (!h) continue;
        try {
          const r = await h({ event, cwd, ...payload }); if (r === undefined || r === null) continue;
          if (typeof r === "string") { res.context = (res.context ? res.context + "\n" : "") + r; continue; }
          if (r.block !== undefined) { res.block = r.block; return res; }
          if (r.context) res.context = (res.context ? res.context + "\n" : "") + r.context;
          if (r.args) res.args = r.args;
        } catch (e) { const msg = `plugin ${p.name} (${event}): ${(e as Error).message}`; if (p.failClosed) { res.block = msg; return res; } res.warnings.push(msg); }
      }
      return res;
    },
  };
}
export const applySystem = (plugins: Plugin[], base: string, cwd: string) => plugins.reduce((s, p) => (p.system ? p.system(s, { cwd }) : s), base);

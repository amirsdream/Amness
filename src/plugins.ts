// Plugins: harness behaviour written as code. A plugin is a TypeScript or JavaScript file in `.amness/plugins/` (or `~/.amness/plugins/`) that can add tools, run code at every
// point of the loop (the eight hook events, in-process, with the full payload), rewrite the system prompt, and contribute evaluation tasks, graders and harness variants.
// Everything the built-in guards do can be done from here, and `amness eval` can then compare your harness against the others like any built-in variant.
// A plugin runs with your full permissions, so project plugins load only after you approve that exact set of files (same rule as project hooks).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Case, MetricFn, Variant } from "./evals.ts";
import type { Grader } from "./grade.ts";
import type { Guard, Message, Model, Tool } from "./harness.ts";
import type { MemoryBackend } from "./memory.ts";
import type { RouteInfo } from "./router.ts";
import type { HookEvent, HookResult, HookRunner } from "./hooks.ts";
import { exec } from "node:child_process";
import { posixShell } from "./shell.ts";

export type HookReturn = { block?: string; context?: string; args?: Record<string, unknown>; /** PreModel only: the tools that may be called in this turn */ tools?: string[]; then?: string } | string | void;
export type HookHandler = (payload: Record<string, unknown> & { event: HookEvent; cwd: string }) => HookReturn | Promise<HookReturn>;
/** A harness variant for `amness eval`, as data (switch guards off, add plugins, change the prompt) or as code (`build` returns the whole Variant). */
export type VariantSpec = {
  off?: Guard[]; maxSteps?: number; /** run with the case's verify command as the finish gate (default true) */ verify?: boolean; review?: boolean;
  /** plugins (by name) active in this variant, in addition to the plugin that defines it */ plugins?: string[];
  system?: (base: string) => string;
  build?: (model: Model, o: { maxSteps?: number; maxTokens?: number }) => Variant;
};
/** What a plugin's slash command can do: print, send a message to the agent, run a command, read the folder. Nothing else of the UI is exposed on purpose. */
export type PluginCtx = { cwd: string; say(text: string): void; /** send a message to the agent, as if you had typed it */ ask(text: string): Promise<void>; run(cmd: string, timeoutMs?: number): Promise<{ code: number; output: string }> };
export type PluginCommand = { name: string; help: string; args?: string; run(ctx: PluginCtx, arg: string): void | Promise<void> };
/** A tool call about to run, as a policy sees it. */
export type PolicyCall = { tool: string; args: Record<string, unknown>; cwd: string };
export type PolicyDecision = { action: "allow" | "ask" | "deny"; reason?: string; plugin?: string };
export type PolicyResult = "allow" | "ask" | "deny" | { action: "allow" | "ask" | "deny"; reason?: string } | void;
/**
 * Ask every plugin's `policy`. A deny always wins, then an ask, then an allow. The caller decides what each answer may do:
 * the harness never lets a policy relax the safety floor or the untrusted-text check, only tighten them or skip an ordinary prompt.
 */
export async function checkPolicies(plugins: Plugin[], call: PolicyCall): Promise<PolicyDecision | undefined> {
  let best: PolicyDecision | undefined; const rank = { allow: 1, ask: 2, deny: 3 };
  for (const p of plugins) {
    if (!p.policy) continue;
    let r: PolicyResult; try { r = await p.policy(call); } catch (e) { r = { action: p.failClosed ? "deny" : "ask", reason: `policy of plugin ${p.name} failed: ${(e as Error).message}` }; }   // a broken policy never silently allows
    if (!r) continue; const d: PolicyDecision = { ...(typeof r === "string" ? { action: r } : r), plugin: p.name };
    if (!best || rank[d.action] > rank[best.action]) best = d;
  }
  return best;
}

/** A finish gate: your own check that must pass before the agent may finish. It sees what really happened (files changed, whether tests passed after the last edit) and can run commands. */
export type GateCtx = { summary: string; task: string; changed: string[]; testsAfterLastEdit?: boolean; notes: string[]; cwd: string; run: PluginCtx["run"]; /** how many times this gate has already rejected this task */ rejections: number };
export type GateResult = boolean | string | string[] | { pass: boolean; findings?: string[] } | void;
export type FinishGate = { name: string; /** rejections before the run may finish anyway (default 2, so a wrong gate cannot trap the agent) */ maxRejections?: number; check(ctx: GateCtx): GateResult | Promise<GateResult> };
/** Several reviewers vote: the finish is accepted when at least `quorum` of them pass ("all", "majority", or a number). */
export function votingGate(name: string, reviewers: { name: string; review(ctx: GateCtx): GateResult | Promise<GateResult> }[], quorum: "all" | "majority" | number = "majority", maxRejections = 2): FinishGate {
  return { name, maxRejections, async check(ctx) {
    const votes = await Promise.all(reviewers.map(async (r) => { try { return { name: r.name, ...normalizeGate(await r.review(ctx)) }; } catch (e) { return { name: r.name, pass: true, findings: [`(${r.name} could not run: ${(e as Error).message})`] }; } }));
    const need = quorum === "all" ? votes.length : quorum === "majority" ? Math.floor(votes.length / 2) + 1 : quorum, passes = votes.filter((v) => v.pass).length;
    return passes >= need ? true : { pass: false, findings: [`only ${passes} of ${votes.length} reviewers accepted this (${need} needed)`, ...votes.filter((v) => !v.pass).flatMap((v) => v.findings.map((f) => `${v.name}: ${f}`))] };
  } };
}
const normalizeGate = (r: GateResult): { pass: boolean; findings: string[] } => r === undefined || r === true ? { pass: true, findings: [] } : r === false ? { pass: false, findings: ["the check failed"] } : typeof r === "string" ? { pass: false, findings: [r] } : Array.isArray(r) ? { pass: r.length === 0, findings: r } : { pass: r.pass, findings: r.findings ?? [] };
const shellRun = (cwd: string): PluginCtx["run"] => (cmd, ms = 60_000) => new Promise((res) => exec(cmd, { cwd, shell: process.platform === "win32" ? posixShell() : undefined, timeout: ms, maxBuffer: 10 << 20 }, (err: any, out, errOut) => res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: String(out) + String(errOut) })));

export type Plugin = {
  name: string; description?: string;
  tools?: Tool[];
  hooks?: Partial<Record<HookEvent, HookHandler>>;
  /** a handler that throws blocks instead of warning (for hooks that enforce a rule) */ failClosed?: boolean;
  /** your own context strategy (compaction, clearing, memory injection): called before every model request, may return a replacement message list */ context?: (msgs: Message[], info: { step: number; promptTokens: number; budget: number }) => Message[] | void | Promise<Message[] | void>;
  /** replace the built-in memory (notes saved and recalled across sessions) with your own backend; the first plugin that provides one wins */ memory?: MemoryBackend | ((cwd: string) => MemoryBackend);
  /** choose the model for each request: return a model id (same provider; needs `modelById`), or nothing to use the default. Sees the conversation, its size and what the last steps were. */ route?: (info: RouteInfo) => string | undefined | void;
  /** a short line shown in the sidebar (and updated as you work): branch policy, build state, ticket id, anything. Keep it fast: it runs on every redraw (the result is cached for one second). */ status?: (ctx: { cwd: string; running: boolean }) => string | undefined | void;
  /** policy as code: decide allow, ask or deny for each tool call before it runs. It can tighten anything, and it can skip an ordinary approval prompt, but it can never loosen the safety floor or the untrusted-text check. */ policy?: (call: PolicyCall) => PolicyResult | Promise<PolicyResult>;
  /** finish gates: your own checks that must pass before the agent may finish (see GateCtx) */ gates?: FinishGate[];
  /** slash commands for the chat (a name that a built-in command already uses is skipped) */ commands?: PluginCommand[];
  /** rewrite the system prompt (runs once per conversation start) */ system?: (base: string, ctx: { cwd: string }) => string;
  /** evaluation: tasks with graders written as functions, and harness variants */ cases?: Case[]; /** graders for real sessions (`amness plugin grade`): functions of a recorded session that return a score */ graders?: Record<string, Grader>; /** custom numbers to record for every eval run (see MetricFn) */ metrics?: Record<string, MetricFn>; variants?: Record<string, VariantSpec>;
};
/** Identity function that gives you types and completion while writing a plugin. */
export const definePlugin = (p: Plugin): Plugin => p;

const EXT = new Set([".ts", ".mts", ".js", ".mjs"]);
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => EXT.has(extname(f)) && statSync(join(dir, f)).isFile()).sort().map((f) => join(dir, f)) : []);
export const projectPluginDir = (cwd: string) => join(cwd, ".amness", "plugins");
export const projectPluginFiles = (cwd: string) => filesIn(projectPluginDir(cwd));
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
  const withHooks = plugins.filter((p) => (p.hooks && Object.keys(p.hooks).length) || p.gates?.length);
  if (!withHooks.length) return shell;
  const rejections = new Map<string, number>(); let lastTask: unknown;
  return {
    count: () => (shell?.count() ?? 0) + withHooks.reduce((n, p) => n + Object.keys(p.hooks ?? {}).length + (p.gates?.length ?? 0), 0),
    async run(event, payload) {
      const res: HookResult = shell ? await shell.run(event, payload) : { warnings: [] };
      if (res.block) return res;
      for (const p of withHooks) {
        const h = p.hooks?.[event]; if (!h) continue;
        try {
          const r = await h({ event, cwd, ...payload }); if (r === undefined || r === null) continue;
          if (typeof r === "string") { res.context = (res.context ? res.context + "\n" : "") + r; continue; }
          if (r.block !== undefined) { res.block = r.block; return res; }
          if (r.context) res.context = (res.context ? res.context + "\n" : "") + r.context;
          if (r.args) res.args = r.args;
          if (r.tools) res.tools = r.tools;
          if (r.then) res.then = r.then;
        } catch (e) { const msg = `plugin ${p.name} (${event}): ${(e as Error).message}`; if (p.failClosed) { res.block = msg; return res; } res.warnings.push(msg); }
      }
      if (event === "Stop") {                                               // finish gates run after the hooks, with what really happened
        if (payload.task !== lastTask) { lastTask = payload.task; rejections.clear(); }
        for (const p of withHooks) for (const g of p.gates ?? []) {
          const key = `${p.name}:${g.name}`, n = rejections.get(key) ?? 0;
          let v: { pass: boolean; findings: string[] };
          try { v = normalizeGate(await g.check({ summary: String(payload.summary ?? ""), task: String(payload.task ?? ""), changed: (payload.changed as string[]) ?? [], testsAfterLastEdit: payload.testsAfterLastEdit as boolean | undefined, notes: (payload.notes as string[]) ?? [], cwd, run: shellRun(cwd), rejections: n })); }
          catch (e) { res.warnings.push(`plugin ${p.name} gate ${g.name}: ${(e as Error).message}`); continue; }
          if (v.pass) continue;
          const text = `gate "${g.name}" (plugin ${p.name}) found problems:\n${v.findings.map((f) => `- ${f}`).join("\n")}`;
          if (n < (g.maxRejections ?? 2)) { rejections.set(key, n + 1); res.block = text; return res; }
          res.warnings.push(`finishing despite ${text}`);
        }
      }
      return res;
    },
  };
}
export const applySystem = (plugins: Plugin[], base: string, cwd: string) => plugins.reduce((s, p) => (p.system ? p.system(s, { cwd }) : s), base);

/** A starting point for `amness plugin new <name>`. */
export const pluginTemplate = (name: string) => `// .amness/plugins/${name}.ts: a plugin is just an exported object. See docs/plugins.md.
export default {
  name: ${JSON.stringify(name)},
  description: "what this plugin is for",

  // Runs inside the loop. Return nothing to continue, a string to add context, or { block: "why" } to refuse.
  hooks: {
    // PreToolUse: ({ tool, args }) => (tool === "sh" && /rm -rf/.test(String(args.cmd)) ? { block: "no recursive deletes" } : undefined),
    // Stop: ({ summary, changed }) => (changed.length && !/test/i.test(String(summary)) ? { block: "say which tests you ran" } : undefined),
  },

  // A slash command: /${name}
  commands: [{ name: ${JSON.stringify(name)}, help: "say hello from the plugin", run: (ctx) => ctx.say("hello from the ${name} plugin") }],
};
`;

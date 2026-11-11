import { exec, execFile } from "node:child_process";
import { wrapCommand, type SandboxMode } from "./sandbox.ts";
import { childEnv } from "./secrets.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { applyBundle, collectFiles, readBundle, writeBundle, type Bundle } from "./bundle.ts";
import { unifiedDiff } from "./diff.ts";
import { createToolTool, loadSavedTools } from "./dynamic.ts";
import { ToolCache } from "./cache.ts";
import { coverageCheck } from "./coverage.ts";
import { auditCheck } from "./audit.ts";
import { quarantineReader, type Quarantine } from "./quarantine.ts";
import { PlanCache, planBlock, planFrom } from "./plancache.ts";
import { buildPacket } from "./packet.ts";
import { hollowWhy } from "./hollow.ts";
import { createHarness, defineTool, clip, handoffSeed, isSmallTalk, makeHandoff, pinRules, Registry, type ToolCtx, type Approve, type Budget, type Event, type Guard, type Message, type Model, type Tool } from "./harness.ts";
import { MemoryStore, isMemoryBackend, memoryTools, type MemoryBackend } from "./memory.ts";
import type { Embedder } from "./embed.ts";
import { Guidance } from "./guidance.ts";
import { currentShell, shellInvocation, shellNote, slash } from "./shell.ts";
import { ProcessManager } from "./procs.ts";
import { reviewedApprove } from "./approver.ts";
import { Diagnostics, type LspServer } from "./lsp.ts";
import { Ledger } from "./ledger.ts";
import { relatedFiles, CodeIndex, indexTools } from "./codeindex.ts";
import { AGENT_TOOLS, WRITE_TOOLS, isWriter, loadAgents, type AgentDef } from "./agents.ts";
import type { Roles } from "./route.ts";
import { windowOf, type ModelTier } from "./card.ts";
import type { LadderModel } from "./ladder.ts";
import { applyDiff, createWorktree, isRepo, removeWorktree, worktreeDiff, type Worktree } from "./worktree.ts";
import { loadSkills, skillsBlock, skillTool, type Skill } from "./skills.ts";
import { SkillState, draftSkill, rankSkills } from "./skillmgr.ts";
import { applyOps, parsePatch, replaceMany } from "./patch.ts";
import { proposeContract, reviewWork } from "./review.ts";
import type { HookRunner } from "./hooks.ts";
import { routedByFunction } from "./router.ts";
import { applySystem, checkPolicies, composeHooks, type Plugin } from "./plugins.ts";
import { OBFUSCATED_EXEC, Permissions, commandViews, type PermissionChecker } from "./permissions.ts";

const RISKY: [RegExp, string][] = [
  [/\brm\s+(-\w*[rf]|--recursive|--force)/, "recursive/forced delete"], [/\bsudo\b/, "sudo"],
  [/\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D|rebase)/, "destructive or outward git operation"],
  [/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh/, "pipes a download into a shell"],
  [/\b(npm|pnpm|yarn)\s+(publish|login)|\b(pip|pip3|npm|pnpm|yarn|brew|apt(-get)?|cargo)\s+(install|add|i)\b/, "installs or publishes packages"],
  [/\b(chmod|chown)\s+-R|\bdd\s+if=|\bmkfs|>\s*\/dev\/|:\(\)\s*\{/, "dangerous system command"],
  [/\b(ssh|scp|rsync)\b/, "remote access"],
];
export const riskOf = (cmd: string): string | false => { const views = commandViews(cmd); return RISKY.find(([re]) => views.some((v) => re.test(v)))?.[1] ?? (OBFUSCATED_EXEC.test(cmd) || OBFUSCATED_EXEC.test(views[1] ?? "") ? "decodes or downloads a payload and runs it" : false); };

/** How much the agent may do without asking. default: ask for edits and non-trivial shell; acceptEdits: ask only for shell; plan: read-only; yolo: never ask. */
export type PermMode = "default" | "acceptEdits" | "plan" | "yolo";
/** Inspection-only shell commands (no chaining, redirects or substitutions): always allowed, even in plan mode. */
export const READONLY_CMD = /^\s*(ls|cat|head|tail|wc|pwd|echo|grep|rg|tree|stat|file|which|date|whoami|git\s+(status|log|diff|show|rev-parse|ls-files|blame)|find(?!.*\s-(exec|delete|ok|fprint))|node\s+--version|npm\s+(ls|list|view))(\s[^;&|<>`$()]*)?$/;

const IGNORE = new Set(["node_modules", ".git", "dist", ".amness", "__pycache__", ".venv"]);

/** Explain "command not found" (exit 127): the name is not a program here, and say so when it is really one of the agent's own tools. */
export function withNotFoundHint(out: string, isTool: (name: string) => boolean = () => false, forUser = false): string {
  const miss = /^exit=127\b/.test(out) ? /(?:^|\n|: )([\w.@+-]+): (?:command )?not found/.exec(out)?.[1] : undefined;
  if (!miss) return out;
  return `${out.trimEnd()}\n[exit 127 means "${miss}" is not a program on this machine.${isTool(miss) ? `\n"${miss}" is one of your tools: call it as a tool, not as a command.` : ""}\n${forUser ? `After ! type a command, for example !ls or !git status.` : `Check the spelling, check that it is installed (for example: command -v ${miss}), or use a different command. The \`cmd\` argument must be a shell command line, such as "ls src".`}]`;
}
export function runShell(cmd: string, cwd: string, ms = 60_000, signal?: AbortSignal, sandbox: SandboxMode = "off"): Promise<string> {
  let wrapped: ReturnType<typeof wrapCommand>;
  try { wrapped = wrapCommand(cmd, cwd, sandbox); } catch (e) { return Promise.resolve(`exit=126\nERROR: ${(e as Error).message}`); }          // asked for a sandbox we cannot provide: refuse, never run unprotected
  const done = (err: any, out: string, errOut: string) => `exit=${err ? (err.name === "AbortError" ? "interrupted" : err.killed ? "timeout" : err.code ?? 1) : 0}\n${out}${errOut}`;
  const inv = wrapped ?? shellInvocation(cmd);
  return new Promise((res) => execFile(inv.file, inv.args, { cwd, env: childEnv(process.env, !!wrapped), timeout: ms, maxBuffer: 10 << 20, signal, windowsHide: true }, (err: any, out, errOut) => res(done(err, out, errOut))));
}

/** A file tool wants a path outside the project: the file or folder, the folder access would cover, and whether it would change something there. */
export type OutsideRequest = { path: string; dir: string; write: boolean };
/** File + shell tools confined to `cwd`. Enforces read-before-edit; flags dangerous shell commands as risky. */
export function codeTools(cwd: string, o: { /** called before a command that may change files runs (snapshots, irreversibility notes) */ beforeShell?: (cmd: string) => Promise<void>; /** OS sandbox for shell commands, read each time so it can be switched live */ sandbox?: () => SandboxMode; /** background processes (sh_start, sh_read, sh_stop, sh_list) */ procs?: ProcessManager; /** folder-level instruction files, appended to results the first time the agent works in that folder */ guidance?: Guidance; onChange?: (path: string, created?: boolean) => void; mode?: () => PermMode; /** Run after each successful edit; returns text to append to the tool result (empty when all is well). */ check?: (paths: string[]) => Promise<string>;
  /** Folders outside the project the file tools may use too, read each time (the user allowed them) */ dirs?: () => string[];
  /** Asked before a file tool uses a path outside the project and every allowed folder; true lets it (the caller adds `dir` to `dirs`). Without it such paths are refused. */ outside?: (req: OutsideRequest) => Promise<boolean>;
  /** Extra lines after a search for the files it hit most (guard `anchor`: who imports them, which tests cover them). */ related?: (files: string[]) => string } = {}): Tool[] {
  const mode = o.mode;
  const mutating = mode ? { risky: () => (mode() === "default" ? "modify a file" : false), when: () => mode() !== "plan" } : {};
  const root = resolve(cwd);
  const shRisk = ({ cmd }: { cmd: string }): string | false => (!mode ? riskOf(cmd) : mode() === "yolo" ? false : riskOf(cmd) || (READONLY_CMD.test(cmd) ? false : "run a shell command"));
  const readSet = new Set<string>();
  const patchText = (a: { patch?: string; file?: string }): string => { if (a.patch) return a.patch; if (!a.file) throw new Error("give `patch` or `file`"); return readFileSync(abs(a.file), "utf8"); };
  const inside = (a: string) => [root, ...(o.dirs?.() ?? []).map((d) => resolve(d))].some((r) => a === r || a.startsWith(r.endsWith(sep) ? r : r + sep));
  const abs = (p: string) => {
    const a = resolve(root, p);
    if (!inside(a)) throw new Error(`path escapes the workspace: ${p}`);
    return a;
  };
  /** Before a file tool runs: a path outside the project and the allowed folders is asked about (once per folder, see `outside`), or refused. */
  const reach = (write: boolean, paths: (a: any) => (string | undefined)[]) => async (a: any) => {
    for (const p of paths(a)) {
      if (!p) continue;
      const full = resolve(root, p); if (inside(full) || !o.outside) continue;   // without `outside`, abs() refuses it as before
      const dir = existsSync(full) && statSync(full).isDirectory() ? full : dirname(full);
      if (!(await o.outside({ path: full, dir, write }))) throw new Error(`the user did not allow access to ${dir}, which is outside the project. Do not try other paths there; work inside the project or ask the user`);
    }
  };
  const patchPaths = (a: { patch?: string; file?: string }) => { try { return [a.file, ...parsePatch(patchText(a)).map((op) => op.path)]; } catch { return [a.file]; } };
  const mustRead = (p: string) => {
    if (existsSync(abs(p)) && !readSet.has(abs(p))) throw new Error(`read ${p} (read_file or grep) before changing it, so your edit is based on its real contents`);
  };
  const walk = (d: string, out: string[]) => {
    for (const e of readdirSync(d).sort()) {
      if (IGNORE.has(e) || out.length >= 300) continue;
      const p = resolve(d, e);
      statSync(p).isDirectory() ? walk(p, out) : out.push(slash(relative(root, p)));
    }
    return out;
  };

  /** A missing file is usually a wrong guess at a name: offer the closest real files (same name elsewhere, or a similar name) so the next call is not another guess. */
  const suggest = (p: string): string => {
    const all: string[] = []; const scan = (d: string) => { for (const e of readdirSync(d)) { if (IGNORE.has(e) || all.length >= 6000) continue; const f = resolve(d, e); try { statSync(f).isDirectory() ? scan(f) : all.push(slash(relative(root, f))); } catch { /* unreadable */ } } };
    try { scan(root); } catch { /* none */ }
    const base = p.split(/[\\/]/).pop()!.toLowerCase(), stem = base.replace(/\.[^.]*$/, "");
    const scored = all.map((f) => { const b = f.split("/").pop()!.toLowerCase(), s = b.replace(/\.[^.]*$/, ""); return { f, score: b === base ? 3 : s === stem ? 2 : stem.length >= 3 && (s.includes(stem) || stem.includes(s)) ? 1 : 0 }; }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.f.length - b.f.length).slice(0, 4);
    return scored.length ? ` Did you mean: ${scored.map((x) => x.f).join(", ")}?` : " Use list_files or grep to find the right path.";
  };

  return [
    defineTool<{ path?: string }>({ name: "list_files", gate: reach(false, (a) => [a.path]), description: "List files in the workspace (skips node_modules, .git, dist). Max 300.",
      schema: { type: "object", properties: { path: { type: "string" } } }, readOnly: true, cacheable: true,
      run: ({ path }) => path && !existsSync(abs(path)) ? `ERROR: ${path} does not exist.${suggest(path)}` : walk(abs(path ?? "."), []).join("\n") || "(empty)" }),
    defineTool<{ path: string; start?: number; end?: number }>({ name: "read_file", gate: reach(false, (a) => [a.path]), description: "Read a file with line numbers (optionally lines start..end).",
      schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } } }, readOnly: true, cacheable: true, overlap: true,
      stamp: ({ path }) => { try { const s = statSync(abs(path)); return `${s.size}:${s.mtimeMs}`; } catch { return "missing"; } },
      run: ({ path, start, end }) => {
        const a = abs(path); if (!existsSync(a)) throw new Error(`no such file: ${path}.${suggest(path)}`); readSet.add(a);
        const all = readFileSync(a, "utf8").split("\n"); if (all.at(-1) === "") all.pop();            // a trailing newline is not an extra empty line
        return all.slice((start ?? 1) - 1, end).map((l, i) => `${(start ?? 1) + i}\t${l}`).join("\n") + (o.guidance?.nested(path) ?? "");
      } }),
    defineTool<{ pattern: string; path?: string }>({ name: "grep", gate: reach(false, (a) => [a.path]), description: "Recursive regex search (file:line:text). Counts as having read matching files.",
      schema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" }, path: { type: "string" } } }, readOnly: true, cacheable: true,
      run: ({ pattern, path }) => path && !existsSync(abs(path)) ? `ERROR: ${path} does not exist, so nothing was searched.${suggest(path)}` : new Promise<string>((res) => execFile("grep", ["-rnIE", "-m", "20", ...[...IGNORE].map((d) => `--exclude-dir=${d}`), "-e", pattern, path ?? "."],
        { cwd: root, maxBuffer: 10 << 20 }, (_e, out) => {
          const hits = new Map<string, number>();
          for (const l of out.split("\n")) { const f = l.split(":")[0]; if (f) { try { readSet.add(abs(f)); } catch { /* outside */ } const k = slash(f).replace(/^\.\//, ""); hits.set(k, (hits.get(k) ?? 0) + 1); } }
          const top = [...hits].sort((a, b) => b[1] - a[1]).map(([k]) => k);
          res((out.split("\n").slice(0, 100).join("\n") || "no matches") + (top.length && o.related ? o.related(top) : ""));
        })) }),
    defineTool<{ path: string; content: string }>({ name: "write_file", gate: reach(true, (a) => [a.path]), description: "Create a file, or fully overwrite one you have already read.",
      schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } }, ...mutating,
      preview: ({ path, content }) => unifiedDiff(path, existsSync(abs(path)) ? readFileSync(abs(path), "utf8") : null, content).diff,
      run: async ({ path, content }, ctx) => {
        mustRead(path);
        const a = abs(path), before = existsSync(a) ? readFileSync(a, "utf8") : null;
        mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, content); readSet.add(a); o.onChange?.(path, before === null);
        ctx.emit?.({ kind: "edit", ...unifiedDiff(path, before, content), before: before === null || before.length < 500_000 ? before : undefined });
        return `wrote ${content.length} chars to ${path}` + (await o.check?.([path]) ?? "") + (o.guidance?.nested(path) ?? "");
      } }),
    defineTool<{ path: string; old?: string; new?: string; edits?: { old: string; new: string }[] }>({ name: "edit_file", gate: reach(true, (a) => [a.path]), short: "Replace unique text `old` with `new` in a file you read, or pass `edits` (a list of old/new) for several.", description: "Replace exact, unique text in a file you have read. Give `old` and `new`, or an `edits` list of several replacements applied in order (all or nothing). If the text differs only in indentation it is still matched when unique. Shows the result.",
      schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, edits: { type: "array", items: { type: "object", required: ["old", "new"], properties: { old: { type: "string" }, new: { type: "string" } } } } } }, ...mutating,
      preview: ({ path, old, new: nw, edits }) => { const s = readFileSync(abs(path), "utf8"), r = replaceMany(s, edits?.length ? edits : old !== undefined && nw !== undefined ? [{ old, new: nw }] : []); return "error" in r ? undefined : unifiedDiff(path, s, r.out).diff; },
      run: async ({ path, old, new: nw, edits }, ctx) => {
        mustRead(path);
        const list = edits?.length ? edits : old !== undefined && nw !== undefined ? [{ old, new: nw }] : [];
        if (!list.length) return "ERROR: give `old` and `new`, or an `edits` list.";
        const a = abs(path), s = readFileSync(a, "utf8"), r = replaceMany(s, list);
        if ("error" in r) return `ERROR: ${r.error}`;
        writeFileSync(a, r.out); o.onChange?.(path);
        ctx.emit?.({ kind: "edit", ...unifiedDiff(path, s, r.out), before: s.length < 500_000 ? s : undefined });
        const first = list[0], at = r.out.indexOf(first.new.split("\n")[0] ?? ""), line = at >= 0 ? r.out.slice(0, at).split("\n").length : 1;
        return `edited ${path}${list.length > 1 ? ` (${list.length} edits)` : ""}${r.fuzzy ? `; ${r.fuzzy} matched ignoring indentation` : ""}:\n` + r.out.split("\n").slice(Math.max(0, line - 3), line + first.new.split("\n").length + 2).map((l, i) => `${Math.max(1, line - 2) + i}\t${l}`).join("\n") + (await o.check?.([path]) ?? "") + (o.guidance?.nested(path) ?? "");
      } }),
    defineTool<{ patch?: string; file?: string }>({ name: "apply_patch", gate: reach(true, patchPaths), description: "Change several files at once with a patch, all or nothing. Format: `*** Begin Patch`, then per file `*** Update File: path` (hunks start with `@@`, lines begin with space, `-` or `+`), `*** Add File: path` (all lines start with `+`) or `*** Delete File: path`, then `*** End Patch`. A unified diff also works. Existing files must have been read first. Instead of `patch` you can pass `file`: a patch file inside the workspace (a subagent's saved result).",
      schema: { type: "object", properties: { patch: { type: "string" }, file: { type: "string" } } }, ...mutating,
      preview: (a) => { try { const patch = patchText(a); const r = applyOps(parsePatch(patch), (p) => (existsSync(abs(p)) ? readFileSync(abs(p), "utf8") : undefined)); return r.errors.length ? undefined : r.applied.map((x) => unifiedDiff(x.path, x.before, x.after ?? "").diff).join("\n"); } catch { return undefined; } },
      run: async (a, ctx) => {
        let patch: string; try { patch = patchText(a); } catch (e) { return `ERROR: ${(e as Error).message}`; }
        const ops = parsePatch(patch); if (!ops.length) return "ERROR: no files found in the patch. Use `*** Begin Patch` / `*** Update File: path` ... `*** End Patch`, or a unified diff.";
        for (const op of ops) { if (op.op !== "add") mustRead(op.path); else abs(op.path); }
        const r = applyOps(ops, (p) => (existsSync(abs(p)) ? readFileSync(abs(p), "utf8") : undefined));
        if (r.errors.length) return `ERROR: nothing was changed.\n${r.errors.map((e) => "- " + e).join("\n")}\nRe-read the files if they may differ from what you assumed.`;
        const lines: string[] = [];
        for (const x of r.applied) {
          const a = abs(x.path);
          if (x.after === null) { rmSync(a, { force: true }); readSet.delete(a); } else { mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, x.after); readSet.add(a); }
          o.onChange?.(x.path, x.before === null);
          const ch = unifiedDiff(x.path, x.before, x.after ?? "");
          ctx.emit?.({ kind: "edit", ...ch, before: x.before === null || x.before.length < 500_000 ? x.before : undefined });
          lines.push(`${x.after === null ? "deleted" : x.before === null ? "added" : "updated"} ${x.path} (+${ch.added} -${ch.removed})${x.fuzzy ? `, ${x.fuzzy} hunk(s) matched ignoring indentation` : ""}`);
        }
        return `patched ${r.applied.length} file(s):\n${lines.join("\n")}` + (await o.check?.(r.applied.filter((x) => x.after !== null).map((x) => x.path)) ?? "") + (o.guidance?.nested(r.applied[0].path) ?? "");
      } }),
    ...(o.procs ? bgTools(o.procs, shRisk, mode) : []),
    defineTool<{ cmd: string; timeout?: number }>({ name: "sh", description: `Run a command in the workspace shell (${currentShell().name}); returns exit code and output. Dangerous commands need human approval.`,
      schema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" }, timeout: { type: "integer", description: "seconds, default 60" } } },
      risky: shRisk,
      preview: ({ cmd }) => cmd,
      run: async ({ cmd, timeout }, ctx) => {
        if (mode?.() === "plan" && !READONLY_CMD.test(cmd))
          return "ERROR: plan mode is read-only; only inspection commands are allowed (ls, cat, head, tail, grep, find, git status/log/diff/show, wc, pwd). Finish your plan and call exit_plan_mode.";
        if (o.beforeShell && !READONLY_CMD.test(cmd)) { try { await o.beforeShell(cmd); } catch { /* a failed snapshot must not stop the command */ } }
        const out = await runShell(cmd, root, (timeout ?? 60) * 1000, ctx.signal, o.sandbox?.() ?? "off");
        return withNotFoundHint(out, (n) => !!ctx.registry.get(n));
      } }),
  ];
}

/** Tools for long-running commands: start a dev server or watcher, look at its output later, stop it. */
function bgTools(procs: ProcessManager, risky: (a: { cmd: string }) => string | false, mode?: () => PermMode): Tool[] {
  const fmt = (p: { id: string; name: string; status: string; code?: number | null; pid?: number }) => `${p.id} (${p.name}) ${p.status}${p.status === "exited" ? ` with code ${p.code}` : ""}`;
  return [
    defineTool<{ cmd: string; name?: string }>({ name: "sh_start", description: "Start a long-running command in the background (dev server, test watcher, build --watch). Returns an id; use sh_read to see its output and sh_stop to end it. For commands that finish by themselves, use sh.",
      schema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" }, name: { type: "string", description: "short label" } } }, risky, when: () => mode?.() !== "plan", preview: ({ cmd }) => cmd,
      run: ({ cmd, name }) => `started ${fmt(procs.start(cmd, name))}. Read its output with sh_read.` }),
    defineTool<{ id: string; wait_ms?: number; max_chars?: number }>({ name: "sh_read", description: "New output of a background process since the last read, and whether it is still running. `wait_ms` (max 10000) waits for output or exit.", readOnly: true,
      schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, wait_ms: { type: "integer" }, max_chars: { type: "integer" } } },
      run: async ({ id, wait_ms, max_chars }) => { const r = await procs.read(id, { waitMs: wait_ms, maxChars: max_chars }); return `[${id} ${r.status}${r.status === "exited" ? ` code ${r.code}` : ""}${r.skipped ? `; ${r.skipped} earlier chars were dropped` : ""}]\n${r.output || "(no new output)"}`; } }),
    defineTool<{ id: string }>({ name: "sh_stop", description: "Stop a background process (SIGTERM, then SIGKILL after 2 seconds).", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      run: async ({ id }) => `stopped ${fmt(await procs.stop(id))}` }),
    defineTool({ name: "sh_list", description: "List background processes and their status.", readOnly: true, schema: { type: "object", properties: {} }, run: () => procs.list().map(fmt).join("\n") || "no background processes" }),
  ];
}

export const CODE_SYSTEM = `You are an expert software engineer working autonomously in a repository. Complete the task, then call \`finish\`.
Workflow:
1. EXPLORE (proportionate: a small fix needs a handful of reads, not a survey; stop when you know where to change): list_files / grep / read_file to understand the code before changing it. Reproduce the problem or run the existing tests first when possible.
2. EDIT: smallest correct change, matching surrounding style. Prefer edit_file over rewriting files (several replacements in one file: its \`edits\` list); use apply_patch when one change spans several files. Do not touch unrelated code. Never edit tests to make them pass unless the task says so.
3. VERIFY: run the tests/build/command that proves it works. Read failures carefully and fix the root cause. If an approach fails twice, rethink.
4. FINISH: \`finish(summary)\` with what changed, how you verified, and assumptions. It is rejected if verification fails.
MEMORY: notes from earlier sessions may appear below the task; treat them as hints to verify. When you learn something durable that is NOT obvious from the code (the real test command, a convention the user insists on, a correction), save it with memory_save. Never save secrets or task-progress chatter.
Never invent file contents or command output. Don't ask the user questions; choose sensible defaults. Some commands need human approval; if denied, use another route.`;

/** Conversational variant of the prompt: answers questions directly, plans, delegates exploration, works within permission modes. */
/**
 * For models of the local tier (small or open models on your own server), whatever their window: short, plain, imperative, and always
 * ending with `finish`. Small models need fewer tools and plainer instructions (arXiv 2607.08938, read); a plan/execute/submit phase
 * prompt made four small models worse (arXiv 2605.00334, read), so there is no phase structure here.
 */
export const LOCAL_SYSTEM = `You are a software engineer working in the user's repository. Work in small steps.
- A greeting or thanks gets a short reply, no tools.
- Look first: list_files, grep, read_file (read part of a big file with start/end). Never guess what a file says or what a command printed.
- To change code, use edit_file (the exact old text and the new text) or write_file for a new file. Change only what the task needs.
- After a change, run the tests or the build with sh and read the output. If it fails, fix the cause and run it again.
- Each reply that is not your final answer must call a tool. Do not say what you will do: do it.
- When the task is done and checked, call finish with a short summary: what you changed and how you checked it.
- Other tools (memory, skills, repo_map, background shells, subagents) are found with tool_search.`;
/** For small context windows: the same rules as CHAT_SYSTEM and CODE_SYSTEM in about a third of the words. */
export const COMPACT_SYSTEM = `You are a software engineer working in the user's repository. Be concise; cite files as path:line.
- A greeting or thanks gets a short reply, no tools.
- Look before you answer: list_files, grep, read_file (read part of a big file with start/end). Never invent file contents or tool output.
- Change code with edit_file or write_file, then check it (run the tests or the build) before you finish.
- Do what you said in the same turn: no plans without a tool call. Call \`finish\` when the task is done and verified.
- Other tools (memory, skills, repo_map, background shells, subagents) are found with tool_search.`;
export const CHAT_SYSTEM = `You are an expert software engineer pair-programming with the user in their terminal, inside their repository. Be concise and direct; format with Markdown (short paragraphs, \`inline code\`, fenced code blocks).
How to work:
- Questions: answer from the code. Explore first (list_files, grep, read_file; in a large repository start with repo_map, find_refs and impact when you have them) instead of guessing; cite files as path:line. Use the \`task\` tool for broad searches so your own context stays clean.
- Effort: match effort to the question. A fact or one-file question: 3-10 tool calls, no subagent. Comparing or tracing a few things: 10-15 calls. Only a genuinely broad survey justifies \`task\`, and then give each subagent a distinct slice. When your budget notes say it is running low, stop exploring and give the best answer you have, saying what you did not cover.
- Changes: read a file before editing it, make the smallest correct change, then verify it (run the tests/build). For anything with 3+ steps, keep a checklist with \`todo_write\` and update it as you go (exactly one item in_progress).
- When you finish a coding task, call \`finish(summary)\` (what changed, how you verified). For plain questions just answer; no \`finish\` needed.
- Permissions: the user may be asked to approve edits and shell commands. If a call is denied, do not retry it; use another approach or explain what you need. In plan mode you are read-only: investigate, then present a plan with \`exit_plan_mode\` and wait for approval.
- Greetings, thanks and small talk ("hi", "thanks"): answer in a sentence or two without tools, and ask what they want to work on. Do not explore the project unasked.
- If the request is ambiguous in a way that matters, ask ONE short clarifying question; otherwise choose sensible defaults and say what you assumed.
- Notes from earlier sessions may appear below the user's message; treat them as hints to verify. Save durable, non-obvious lessons with memory_save (never secrets).
- Servers and watchers: start them with \`sh_start\` (plain \`sh\` waits for the command to end), read their output with \`sh_read\`, and \`sh_stop\` them when you are done.
- Never invent file contents or command output. The user can type while you work; their new messages arrive between your steps, so adjust course when they do.`;

/**
 * Check an explorer's ANSWER / FILES result against the workspace: every range must name a file inside it and lines that exist.
 * A weak explorer's wrong prose does less damage when the parent gets exact ranges it can read itself (G28).
 */
export function checkRanges(cwd: string, text: string): { ok: true; text: string } | { ok: false; why: string } {
  const answer = /ANSWER:\s*([\s\S]*?)(?:\n\s*FILES:|$)/i.exec(text)?.[1]?.trim();
  const lines = [...text.matchAll(/^\s*-\s*([^\s:]+):(\d+)(?:-(\d+))?\s*(.*)$/gm)];
  if (!answer || !/FILES:/i.test(text)) return { ok: false, why: "its result did not use the ANSWER / FILES format" };
  const good: string[] = [], bad: string[] = [], root = resolve(cwd);
  for (const m of lines) {
    const p = resolve(root, m[1]), a = Number(m[2]), b = Number(m[3] ?? m[2]);
    if (!(p === root || p.startsWith(root + sep)) || !existsSync(p)) { bad.push(`${m[1]} (no such file)`); continue; }
    let n = 0; try { n = readFileSync(p, "utf8").split("\n").length; } catch { bad.push(`${m[1]} (unreadable)`); continue; }
    if (a < 1 || b < a || a > n) { bad.push(`${m[1]}:${a}-${b} (the file has ${n} lines)`); continue; }
    good.push(`- ${m[1]}:${a}-${Math.min(b, n)}${m[4] ? " " + m[4].trim() : ""}`);
  }
  if (!good.length) return { ok: false, why: lines.length ? `none of its file ranges exist (${bad.slice(0, 3).join(", ")})` : "it listed no file ranges" };
  return { ok: true, text: `ANSWER (from the explorer, unchecked): ${clip(answer, 1500)}\nFILES (checked: these ranges exist; read them yourself before you rely on the answer):\n${good.join("\n")}${bad.length ? `\n(dropped ${bad.length} range(s) that do not exist: ${bad.slice(0, 4).join(", ")})` : ""}` };
}

/** The generic advisor's instructions: a short plan or correction, no tools, no chatter. */
const ADVISOR_SYSTEM = `You advise an engineer (another AI model) who is working on a coding task. You see a summary of the task and the work, not the full conversation, and you cannot run anything.
Give the most useful advice in at most 250 words: the plan or the correction that matters most, the risk they are missing, and what to check. Be concrete (files, commands). If the work looks right and nothing important is missing, answer exactly: OK.`;
/** Lines for an executor that carries Anthropic's native advisor tool (when to call it, following Anthropic's guidance). */
const ADVISOR_NATIVE = `\nYou can consult a stronger model with the \`advisor\` tool. Call it: after you have looked around and before your first substantive change; when you are stuck or about to change approach; and once before you declare the task done. Do not call it for routine steps.`;
const ADVISOR_GENERIC = `\nYou can ask a stronger model for advice with \`advise({question})\` (a few times per request): before a risky or large change, or when you are stuck. It sees a summary of your work, not your files.`;
/** The explorer's prompt for a local-tier model: the same job in short, plain steps. */
const EXPLORE_LOCAL = `You are a read-only code explorer. Answer the question in the brief.
- Use grep first, then read_file on the lines that matter. About 10 tool calls at most.
- You cannot change anything.
- Then call finish with: the answer in a few sentences, and the files with line numbers (path:line).`;
/** The structured result (exploreRanges): an answer plus exact ranges, so the parent reads the code itself instead of trusting the prose. */
const RANGES_FORMAT = `\n\nFormat of your finish summary (exactly):\nANSWER: <the answer in at most three sentences>\nFILES:\n- <path>:<first line>-<last line> <why it matters>\n(one line per range, at most 8; only ranges you actually read)`;
const EXPLORE_SYSTEM = `You are a read-only code explorer working for another engineer. Investigate the question using list_files, read_file, grep and read-only shell commands. You have a small budget (about 12 tool calls): ask for the most informative things first (grep, then read only the relevant ranges), do not read whole files you do not need, and stop as soon as you can answer. If the question is too broad, answer what you can and say what you did not cover. Report concisely (under 300 words): the answer, the relevant files with line numbers, and anything surprising. You cannot change anything. Finish with \`finish(summary)\`; the requester sees only that summary.`;

export type CodeAgentOptions = {
  /** Conversational mode (the TUI): chat prompt, plus todo_write, task (read-only explorer subagent) and exit_plan_mode tools. */
  chat?: boolean;
  /** The model's tier. "local" uses the short local prompt, the lean tool set and compact tool specs whatever the window. Default: the model card's tier when its profile sets one. */
  tier?: ModelTier;
  /** Only these tools (and finish) are offered. Default: the model card's profile `tools`. */
  toolAllow?: string[];
  /**
   * A stronger model to consult. "native": the main model carries Anthropic's advisor tool itself (only the prompt lines are added here).
   * A Model: the generic advisor: an `advise` tool, plus a consultation before the first change, when stuck, and before finishing (once each).
   * It gets a packet (task, rules, a note of the work so far, files changed, the diff, the last failure), never the transcript, and has no tools.
   */
  advisor?: Model | "native";
  /** Agents defined in code, next to the ones in .amness/agents (a file with the same name wins). Used by the edit:delegate experiment. */
  extraAgents?: AgentDef[];
  /** Take tool calls written as text (see the harness option). Default: the model card's `caps.textToolCalls`. */
  textToolCalls?: boolean;
  /** The recovery ladder (see the harness option); its model is usually also `model`. */
  ladder?: LadderModel;
  /** Most consultations of the generic advisor per request (default 4). */
  advisorCap?: number;
  /** Keep the tool list fixed for the session (tool_search plus call_tool); see the harness option. */
  stableTools?: boolean;
  /** The explorer answers with exact file ranges (ANSWER / FILES lines) that are checked against the files; the parent reads them itself. Off by default (not measured). */
  exploreRanges?: boolean;
  /** Offer the `task` tool (explorer and custom subagents). Default: on in chat mode only. */
  subagents?: boolean;
  /** Live permission mode. When given, edits and shell commands ask for approval per the mode (see PermMode); omit for the autonomous behaviour. */
  permissions?: { mode: () => PermMode };
  /** Polled every turn for messages the user typed while the agent works. */
  inbox?: () => string[];
  /** Rewrite old messages only where that saves more than the lost prompt cache costs (see Options.governRewrites); `cachedPrice` and `cacheTtlMs` tune it. */
  governRewrites?: boolean; cachedPrice?: number; cacheTtlMs?: number;
  /** Characters of transcript before old tool output is shortened (see Options.contextBudget). */
  contextBudget?: number;
  /** Asked when the user approves a plan: the plan as they edited it, if they did. The agent is told to follow that version. */
  editedPlan?: () => string | undefined;
  model: Model;
  cwd: string;
  /** Shell command that must exit 0 (e.g. "npm test") before `finish` is accepted. */
  verify?: string;
  /** Fast command (typecheck, lint) run after every edit. Only a failure is shown to the model, appended to the edit result, so mistakes are caught one step after they happen. */
  check?: string;
  /** Ask an installed language server (typescript-language-server, pyright, gopls, rust-analyzer) for errors in each file after it is edited, and append them to the edit result. Pass servers to override the defaults. Off by default. */
  lsp?: boolean | { servers?: LspServer[] };
  approve?: Approve;
  budget?: Budget;
  maxSteps?: number;
  tools?: Tool[];
  /** Let the agent define its own shell-backed tools (each creation needs approval). Saved to `.amness/tools.json` and reloaded next run. */
  selfExtend?: boolean;
  off?: Guard[];
  onEvent?: (e: Event) => void;
  /** Persist transcript here after every turn; run(task, {resume:true}) continues from it. */
  checkpointFile?: string;
  /** Durable memory across sessions (markdown files in <cwd>/.amness/memory + ~/.amness/memory). Default on. */
  memory?: boolean | MemoryStore | MemoryBackend;
  /** Load AGENTS.md (or CLAUDE.md / GEMINI.md) from the workspace root and from folders the agent works in. Default on. */
  guidance?: boolean;
  /** Called before a command that may change files runs: take a snapshot, note that it cannot be undone. */
  beforeShell?: (cmd: string) => Promise<void>;
  /** Folders outside the project the file tools may use too (read each time), and the question to ask before using any other outside path. Without `outside`, outside paths are refused. Subagents get both. */
  dirs?: () => string[];
  outside?: (req: OutsideRequest) => Promise<boolean>;
  /** Mask secrets in tool output before the model sees it (default on). */
  redact?: boolean;
  /** Commands that contain text copied from untrusted tool results (web pages, MCP servers): "ask" (default), "deny" or "off". */
  taint?: "ask" | "deny" | "off";
  /** Record full messages in events so a trace can be replayed (`replay`). */
  record?: boolean;
  /** Structural code index tools (repo_map, find_refs, impact), offered when the repository has at least `minFiles` source files (default 25). */
  index?: boolean | { minFiles?: number };
  /** Discover custom subagents (.amness/agents/*.md, .claude/agents/*.md; project and home) for the `task` tool. Default on. */
  agents?: boolean;
  /** Models that agents can name in their front matter (`model: fast`). */
  agentModels?: Record<string, Model>;
  /** Different models for different jobs: `explore` (the read-only explorer), `compact` (handoff notes and /compact), `review` (the independent reviewer). Unset roles use `model`. */
  models?: Roles;
  /** Discover SKILL.md folders (.amness/skills, .agents/skills, .claude/skills; project and home) and offer them through the `skill` tool. Default on. */
  skills?: boolean;
  /** Run shell commands under an OS sandbox: "workspace" (writes only in the project and temp/cache folders, `.git` read-only) or "strict" (also no network). A getter lets you switch it live. */
  sandbox?: SandboxMode | (() => SandboxMode);
  /** An independent, skeptical reviewer (a fresh context that cannot edit): it writes acceptance criteria before the work and checks the result against them before a finish is accepted. Costs extra model calls; off by default. `model` lets it be a different model. */
  review?: boolean | { model?: Model };
  /** A second model looks at each risky call before the user is asked: it can approve (with a stated reason, logged as a policy event) or pass the call on. It never sees the safety floor or untrusted-text calls. Pass { model } to use a cheaper model. Costs one short model call per risky action. */
  approvalReviewer?: boolean | { model?: Model };
  /** Turns without any measurable improvement before the loop reflects and then stops (default 8; 0 = off). */
  stagnationTurns?: number;
  /** "required": a tool call at every step, for task runs (ignored in chat, where a plain answer is fine). Usually set by the model's profile. */
  toolChoice?: "auto" | "required";
  /** Cap on thinking tokens per model request (OpenAI-compatible servers that support it). Usually set by the model's profile. */
  thinkingBudget?: number;
  /** Extra fields merged into every model request. Usually set by the model's profile (`request`). */
  request?: Record<string, unknown>;
  /** Send the model's earlier thinking back with the history. Usually set by the model's profile (`keepThinking`). */
  keepThinking?: boolean;
  /** Read untrusted tool output (web, MCP) with a separate tool-less model call first (dual LLM); true uses the cheap-role model (or the main one), a function replaces the reader. A plugin's \`quarantine\` wins. */
  quarantine?: boolean | Quarantine;
  /** Background process tools (sh_start / sh_read / sh_stop / sh_list). Default on. Call `agent.procs?.dispose()` when you are done. */
  background?: boolean;
  /** Lifecycle hooks, e.g. `Hooks.load(cwd, { trustProject: true })`. Nothing runs unless you pass this. */
  hooks?: HookRunner;
  /** Create a model from an id (same provider): needed for plugins that route requests with `route`. */
  modelById?: (id: string) => Model;
  /** Wrap or replace every tool the agent gets (chaos evals use it to make tools fail on purpose). */
  wrapTools?: (tools: Tool[]) => Tool[];
  /** Plugins (see plugins.ts): extra tools, in-process hooks on every loop event, system-prompt rewrites. */
  plugins?: Plugin[];
  /** Permission rules plus the built-in safety floor (see `Permissions`). Default: the floor alone. Pass `false` to switch even that off. */
  rules?: PermissionChecker | false;
  /** Turns on semantic memory retrieval (blended with keyword ranking). See `openaiEmbedder`. */
  embedder?: Embedder;
  /** Start a fresh context with a handoff note when the transcript gets big. Default: at 120k prompt tokens / 500k chars. */
  rollover?: { afterTokens?: number; afterChars?: number } | false;
  /** The model's context window in tokens. Set for small or local models (8192): the loop then keeps every request inside it and recovers from "context too long" errors. See `Options.contextWindow` in harness.ts. */
  contextWindow?: number | (() => number | undefined);
  /** Shorter tool definitions. Default: on for a small context window (16k or less), off otherwise. */
  compactSchemas?: boolean;
  /** Offer the plan of a similar finished task, and keep the plan of this one when it finishes (see plancache.ts). Off by default: not measured yet. */
  plans?: boolean;
  /** Called when the window size was learned from a provider error, so it can be remembered. */
  onWindow?: (tokens: number, modelId?: string) => void;
  /** Interrupt a running agent (e.g. Ctrl-C). It stops at a safe point with the checkpoint written, so it can be resumed. */
  signal?: AbortSignal | (() => AbortSignal | undefined);
  /** Recorded in exported bundles so you can see where a session came from. */
  meta?: { provider?: string; model?: string };
};

export type RunOptions = { /** pictures to show the model with the task (needs a vision-capable model) */ images?: { mime: string; data: string }[]; resume?: boolean; bundle?: Bundle | string; overwrite?: boolean };

export function createCodeAgent(o: CodeAgentOptions) {
  const plugins = o.plugins ?? [];
  const routers = plugins.filter((p) => p.route);
  if (plugins.length) o = { ...o, model: routers.length && o.modelById ? routedByFunction(o.model, o.modelById, (i) => { for (const p of routers) { const r = p.route!(i); if (r) return r; } }) : o.model, hooks: composeHooks(o.hooks, plugins, o.cwd), tools: [...(o.tools ?? []), ...plugins.flatMap((p) => p.tools ?? [])] };
  const policyFn = plugins.some((p) => p.policy) ? (c: { tool: string; args: Record<string, unknown> }) => checkPolicies(plugins, { ...c, cwd: o.cwd }) : undefined;
  /** A small context window (16k tokens or less, like a local 30B model on 8k): a shorter system prompt, compact skills and memory blocks, and the rarely used tools out of the prompt. A request for "hi" then costs about 1.5k tokens instead of 3.4k. */
  const small = () => { const w = (typeof o.contextWindow === "function" ? o.contextWindow() : o.contextWindow) ?? windowOf(o.model); return !!w && w <= 16_384; };
  // The model's tier, separate from its window: only a tier that was set (the option, or the model's profile) changes the prompt and tools; a guessed one does not, until measured.
  const localTier = () => (o.tier ?? (o.model.card?.tierFrom === "profile" ? o.model.card.tier : undefined)) === "local";
  const lean = () => small() || localTier();
  const SYS = (chat: boolean | undefined) => applySystem(plugins, (small() ? COMPACT_SYSTEM : localTier() ? LOCAL_SYSTEM : chat ? CHAT_SYSTEM : CODE_SYSTEM) + (o.advisor === "native" ? ADVISOR_NATIVE : advisorModel ? ADVISOR_GENERIC : "") + "\n" + shellNote() + ` Working directory: ${slash(resolve(o.cwd))} (commands and relative paths start there).`, o.cwd);   // without it a model guesses (\`cd /home/user\`) and loses steps
  const toolsFile = resolve(o.cwd, ".amness/tools.json");
  const touched = new Set<string>(), created = new Set<string>();
  const guidance = o.guidance === false ? undefined : new Guidance(o.cwd);
  const toolCache = new ToolCache();     // results of pure reads, shared by every run of this agent
  const plans = o.plans ? new PlanCache(resolve(o.cwd, ".amness/plans")) : undefined;
  const sbx = o.sandbox, sandboxMode: () => SandboxMode = typeof sbx === "function" ? sbx : () => sbx ?? "off";
  let agentList: AgentDef[] = []; const agentWarnings: string[] = []; let patchCount = 0;
  const agentOf = (name?: string) => (name && name !== "explore" ? agentList.find((a) => a.name === name) : undefined);
  const rescanAgents = () => { if (o.agents === false) return; const r = loadAgents(o.cwd); agentList = [...r.agents, ...(o.extraAgents ?? []).filter((x) => !r.agents.some((a) => a.name === x.name))]; agentWarnings.splice(0, agentWarnings.length, ...r.warnings); };
  rescanAgents();
  let tasksThisRequest = 0; const MAX_SUBAGENTS_PER_REQUEST = 6;
  let taskSlots = 3; const taskWaiters: (() => void)[] = [];
  const acquireTask = async () => { if (taskSlots > 0) { taskSlots--; return; } await new Promise<void>((r) => taskWaiters.push(r)); };
  const releaseTask = () => { const w = taskWaiters.shift(); if (w) w(); else taskSlots++; };
  const codeIndex = o.index === false ? undefined : new CodeIndex(o.cwd), indexMin = typeof o.index === "object" ? o.index.minFiles ?? 25 : 25;
  let skillList: Skill[] = [], allSkillList: Skill[] = []; const skillWarnings: string[] = [];
  const skillState = new SkillState(o.cwd), loadedSkills = new Set<string>();      // which skills are off, how often each was used, and which ones this run loaded
  const onSkillLoad = (n: string) => { skillState.loaded(n); loadedSkills.add(n); };
  /** The Skills block for a task: the most relevant ones listed (all of them when there are few), the rest counted. Listing a skill is counted in its stats. */
  const skillBlockFor = (task: string) => { const shown = rankSkills(skillList, task, small() ? 4 : 8, skillState.stats); skillState.offered(shown.map((s) => s.name)); return skillsBlock(shown, small(), skillList.length - shown.length); };
  const rescan = () => { if (o.skills === false) return; const r = loadSkills(o.cwd); allSkillList = r.skills; skillList = r.skills.filter((s) => !skillState.isOff(s.name)); skillWarnings.splice(0, skillWarnings.length, ...r.warnings); if (skillList.length && !registry.get("skill")) registry.add(skillTool(() => skillList, onSkillLoad)); };
  const procs = o.background === false ? undefined : new ProcessManager(resolve(o.cwd), { sandbox: sandboxMode });
  const fromPlugin = plugins.map((p) => (typeof p.memory === "function" ? p.memory(o.cwd) : p.memory)).find(Boolean);
  const backend: MemoryBackend | undefined = o.memory === false ? undefined : o.memory instanceof MemoryStore ? o.memory : isMemoryBackend(o.memory) ? o.memory : fromPlugin ?? MemoryStore.forWorkspace(resolve(o.cwd));
  const memory = backend instanceof MemoryStore ? backend : undefined;       // the built-in store has extras (embeddings, consolidation, graph) that a custom backend does not need to offer
  if (memory && o.embedder) memory.embedder = o.embedder;
  const mode = o.permissions?.mode;
  const approve: Approve | undefined = o.approve && o.approvalReviewer ? reviewedApprove(o.approve, { model: (typeof o.approvalReviewer === "object" && o.approvalReviewer.model) || o.model, task: () => task, onDecision: (d) => o.onEvent?.({ kind: "policy", tool: d.tool, action: d.decision === "approve" ? "allow" : "ask", reason: `reviewer: ${d.reason}` }) }) : o.approve;
  const lsp = o.lsp ? new Diagnostics(o.cwd, typeof o.lsp === "object" ? o.lsp : {}) : undefined;
  const shellCheck = o.check ? async () => { const out = await runShell(o.check!, o.cwd, 60_000); return out.startsWith("exit=0") ? "" : `\n\n[post-edit check \`${o.check}\` failed; fix this before moving on]\n${clip(out, 1500)}`; } : undefined;
  const postEdit = shellCheck || lsp ? async (paths: string[]) => (await shellCheck?.() ?? "") + (await lsp?.report(paths) ?? "") : undefined;
  const wrap = o.wrapTools ?? ((t: Tool[]) => t);
  const registry = new Registry(wrap([...codeTools(o.cwd, { guidance, procs, beforeShell: o.beforeShell, sandbox: sandboxMode, onChange: (p, isNew) => { touched.add(p); if (isNew) created.add(slash(p).replace(/^\.\//, "")); }, mode, check: postEdit, dirs: o.dirs, outside: o.outside, related: o.off?.includes("anchor") ? undefined : (files) => (codeIndex ? relatedFiles(codeIndex, files) : "") }), ...(backend ? memoryTools(backend) : []), ...(o.tools ?? [])]));
  const shown = new Set<string>();   // memory notes already in this conversation
  const rescanIndex = () => { if (codeIndex && !registry.get("repo_map") && codeIndex.list().length >= indexMin) registry.add(...indexTools(codeIndex)); };
  rescan(); rescanIndex();
  registry.lean = { when: lean, names: new Set(["memory_save", "memory_search", "memory_forget", "todo_write", "skill", "task", "repo_map", "impact", "find_refs", "sh_start", "sh_read", "sh_stop", "sh_list", "apply_patch"]) };
  { const allow = o.toolAllow ?? o.model.card?.profile?.tools; if (allow?.length) registry.allow = new Set([...allow, "finish", "tool_search"]); }
  let todos: { content: string; status: "pending" | "in_progress" | "done" }[] = [];
  if (o.chat) {
    registry.add(
      defineTool<{ todos: typeof todos }>({
        name: "todo_write", readOnly: true,
        description: "Maintain a checklist for multi-step work. Send the FULL list each time. Exactly one item in_progress; mark items done as you finish them.",
        schema: { type: "object", required: ["todos"], properties: { todos: { type: "array", items: { type: "object", required: ["content", "status"],
          properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "done"] } } } } } },
        run: ({ todos: t }, ctx) => { todos = t; ctx.emit?.({ kind: "todos", todos: t }); return "todo list updated"; },
      }),
      defineTool<{ plan: string }>({
        name: "exit_plan_mode", readOnly: true, risky: true, when: () => mode?.() === "plan", preview: ({ plan }) => plan,
        description: "Plan mode only: present your finished plan to the user for approval. After approval you can edit files.",
        schema: { type: "object", required: ["plan"], properties: { plan: { type: "string", description: "the plan, in Markdown: what you will change and why, in order" } } },
        run: () => { const e = o.editedPlan?.()?.trim(); return e ? `The user approved the plan with their own changes. Follow this version, not yours:\n\n${e}\n\nImplement it now.` : "The user approved the plan. Implement it now."; },
      }),
    );
  }
  // Subagents: in the chat app, and in `amness run` when asked for (an explore model, or --subagents).
  if (o.subagents ?? o.chat) registry.add(
      defineTool<{ description: string; agent?: string }>({
        name: "task", readOnly: true, parallel: true, concurrent: ({ agent }) => { const d = agentOf(agent); return !d || !isWriter(d) || d.isolation === "worktree"; },
        get description() { return `Delegate work to a subagent with its own fresh context: it sees only your brief and returns only its summary, so the brief must state the objective, where to look, what NOT to cover (so parallel subagents do not repeat each other) and what to report. Default: a read-only explorer for broad searches or questions that need reading many files; at most 3 run at once. Do not delegate what one grep or read would answer: a subagent costs a full session of tokens.${agentList.length ? ` Other agents (pass \`agent\`): ${agentList.map((a) => `${a.name}: ${a.description}${isWriter(a) ? (a.isolation === "worktree" ? " [edits in an isolated copy and returns a patch]" : " [can edit files]") : ""}`).join("; ")}.` : ""}`; },
        schema: { type: "object", required: ["description"], properties: { description: { type: "string", description: "complete brief: the question or job, where to look, what to report" }, agent: { type: "string", description: "which agent (default: the read-only explorer)" } } },
        run: async (args, ctx) => { await acquireTask(); try { return await runTask(args, ctx); } finally { releaseTask(); } },
      }),
  );
  // Takeover: a worker on another model that fails hands the work back to the parent, plainly, and is counted. After TAKEOVER_LIMIT failures of one role, that role runs on the main model for the rest of the session.
  const takeovers = new Map<string, number>(), TAKEOVER_LIMIT = 2;
  const takeover = (role: string, model: string, why: string, partial: string) => {
    const n = (takeovers.get(role) ?? 0) + 1; takeovers.set(role, n);
    o.onEvent?.({ kind: "takeover", role, model, reason: why, count: n } as Event);
    const off = n >= TAKEOVER_LIMIT ? ` This is failure ${n} of ${role} on ${model}: from now on ${role} runs on the main model.` : "";
    return `TAKEOVER: the ${role} on ${model} failed: ${why}. Do this part yourself (read the files directly).${off}${partial.trim() ? `\nWhat it said before it failed (unchecked):\n${clip(partial, 1500)}` : ""}`;
  };
  /** The `task` tool's work: a read-only explorer, or one of the custom agents. */
  async function runTask({ description, agent }: { description: string; agent?: string }, ctx: ToolCtx): Promise<string> {
    let slice: Budget | undefined;
    const out = await runTaskInner({ description, agent }, ctx, (b) => (slice = b));
    return out + (slice && o.budget && Number.isFinite(o.budget.maxTokens) ? `\n[subagent used about ${Math.max(1, Math.round(slice.effective / 1000))}k tokens; the budget for this request is ${Math.round(o.budget.fraction * 100)}% used]` : "");
  }
  async function runTaskInner({ description, agent }: { description: string; agent?: string }, ctx: ToolCtx, setSlice: (b: Budget | undefined) => void): Promise<string> {
    const track = <T,>(b: T) => { setSlice(b as unknown as Budget); return b; };
    if (++tasksThisRequest > MAX_SUBAGENTS_PER_REQUEST) return `ERROR: ${MAX_SUBAGENTS_PER_REQUEST} subagents have already run for this request. Work with what they reported, read the few remaining files yourself, or answer and say what you did not cover.`;
          const d = agentOf(agent);
          const unknown = agent && !["explore", "explorer"].includes(agent.toLowerCase()) && !d ? agent : undefined;            // a wrong name should not cost a round trip: use the read-only explorer and say so
          if (unknown) o.onEvent?.({ kind: "nudge", detail: `no agent named "${unknown}"; used the read-only explorer` });
          const plan = mode?.() === "plan", emitAs = (name: string) => (e: Event) => o.onEvent?.({ ...e, agent: name, parent: ctx.callId } as unknown as Event);
          if (!d) {
            // The explorer runs with its own model's settings: its window comes from the card (the harness reads it), and a small window or a local tier gets compact tool specs and a short prompt.
            const em = (takeovers.get("explore") ?? 0) >= TAKEOVER_LIMIT ? o.model : (o.models?.explore ?? o.model), ew = windowOf(em), emLocal = em.card?.tierFrom === "profile" && em.card.tier === "local";
            const ranges = !!o.exploreRanges, label = em.card?.id ?? (em === o.model ? "the main model" : "the explore model");
            const r = await createHarness({ model: em, system: (emLocal || (ew !== undefined && ew <= 16_384) ? EXPLORE_LOCAL : EXPLORE_SYSTEM) + (ranges ? RANGES_FORMAT : ""), compactSpecs: () => emLocal || (ew !== undefined && ew <= 16_384), tools: codeTools(o.cwd, { mode: () => "plan", dirs: o.dirs, outside: o.outside, related: o.off?.includes("anchor") ? undefined : (files) => (codeIndex ? relatedFiles(codeIndex, files) : "") }), maxSteps: 14, contextBudget: 120_000, policy: policyFn, budget: track(o.budget?.slice(0.12, 60_000)), signal: ctx.signal, onEvent: emitAs("explore") }).run(description);
            const note = unknown ? `(no agent named "${unknown}"; the read-only explorer answered. Available: explore${agentList.map((a) => ", " + a.name).join("")})\n` : "";
            const checked = ranges && r.finished ? checkRanges(o.cwd, r.text) : undefined;
            const why = !r.finished ? `it stopped before finishing (${r.stopped ?? "no finish"})` : !r.text.trim() ? "it returned nothing" : checked && !checked.ok ? checked.why : undefined;
            if (why && em !== o.model) return note + takeover("explore", label, why, r.text);
            return note + (checked?.ok ? checked.text : clip(r.text || "(the explorer returned nothing)", 8000));                 // subagents hand back a condensed result (Anthropic: 1-2k tokens), never their working notes
          }
          const names = plan ? d.tools.filter((t) => !WRITE_TOOLS.has(t)) : d.tools, isolated = d.isolation === "worktree" && isWriter(d) && !plan;
          // The agent's `model:` key: an entry of agentModels, a role name (explore, review, cheap, compact), or a model reference resolved by modelById.
          let agentModel: Model = o.model;
          if (d.model) { const k = d.model as keyof Roles; try { agentModel = o.agentModels?.[d.model] ?? o.models?.[k] ?? o.modelById?.(d.model) ?? o.model; } catch (e) { return `ERROR: agent ${d.name} names model "${d.model}", which cannot be used: ${(e as Error).message}`; } }
          let wt: Worktree | undefined; if (isolated) { if (!(await isRepo(o.cwd))) return "ERROR: isolation: worktree needs a git repository with at least one commit"; wt = await createWorktree(o.cwd); }
          try {
            const base = codeTools(wt?.dir ?? o.cwd, { mode: plan ? () => "plan" : mode, sandbox: sandboxMode, dirs: o.dirs, outside: o.outside }).filter((t) => names.includes(t.name));
            if (names.includes("skill") && skillList.length) base.push(skillTool(() => skillList, onSkillLoad));
            const r = await createHarness({
              model: agentModel, system: `${d.prompt}\n\nYou are a subagent working for another engineer. You see only the brief below. Finish with \`finish(summary)\`: what you found or did, concretely, with file paths.`, tools: base, maxSteps: d.maxSteps,
              budget: track(o.budget?.slice(0.25, 120_000)), signal: ctx.signal, approve, permissions: o.rules === false ? undefined : o.rules ?? new Permissions({}, wt?.dir ?? o.cwd), policy: policyFn, hooks: o.hooks, ledger: isolated ? undefined : isWriter(d) ? ledger : undefined, onEvent: emitAs(d.name),
            }).run(description);
            if ((!r.finished || !r.text.trim()) && agentModel !== o.model && !isWriter(d)) return takeover(d.name, agentModel.card?.id ?? d.model ?? d.name, !r.finished ? `it stopped before finishing (${r.stopped ?? "no finish"})` : "it returned nothing", r.text);
            let out = clip(r.finished ? r.text : `(${d.name} did not finish cleanly) ${r.text}`, 8000);
            if (wt) {
              const diff = await worktreeDiff(wt);
              if (diff) { const n = ++patchCount, rel = `.amness/agents/out/${d.name}-${Date.now().toString(36)}-${n}.patch`; mkdirSync(dirname(resolve(o.cwd, rel)), { recursive: true }); writeFileSync(resolve(o.cwd, rel), diff + "\n");
                const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]); out += `\n\n${d.name} worked in an isolated copy; nothing in your working tree has changed yet. Its changes (${files.length} file(s): ${files.slice(0, 8).join(", ")}) are saved as a patch: read ${rel}, then apply it with apply_patch({ file: "${rel}" }).`; }
              else out += `\n\n(${d.name} made no file changes in its isolated copy.)`;
            }
            return out;
          } finally { if (wt) await removeWorktree(wt); }
  }
  if (o.selfExtend) { mkdirSync(dirname(toolsFile), { recursive: true }); registry.add(...loadSavedTools(toolsFile, o.cwd), createToolTool({ cwd: o.cwd, file: toolsFile })); }
  /** SessionStart (first message of a conversation) and UserPromptSubmit hooks: may add context to the message or refuse it. */
  const promptHooks = async (first: boolean, prompt: string): Promise<{ block?: string; context?: string }> => {
    if (!o.hooks?.count()) return {};
    const parts: string[] = [];
    for (const [ev, payload] of [...(first ? [["SessionStart", {}] as const] : []), ["UserPromptSubmit", { prompt }] as const]) {
      const r = await o.hooks.run(ev, payload as Record<string, unknown>).catch(() => undefined);
      for (const w of r?.warnings ?? []) o.onEvent?.({ kind: "hook", event: ev, detail: w, blocked: false });
      if (r?.block) { o.onEvent?.({ kind: "hook", event: ev, detail: r.block, blocked: true }); return { block: `blocked by a ${ev} hook: ${r.block}` }; }
      if (r?.context) { parts.push(r.context); o.onEvent?.({ kind: "hook", event: ev, detail: "added context", blocked: false }); }
    }
    return { context: parts.length ? `[hook context]\n${parts.join("\n")}` : undefined };
  };
  const ledger = new Ledger({ testCommand: o.verify ?? o.check });
  // The generic advisor: a packet, not the transcript; a few hundred words back; capped per request; a failure is silence, never an error.
  let advisorUsed = 0;
  const advisorModel = o.advisor && o.advisor !== "native" ? o.advisor : undefined;
  const consult = async (why: string, msgs: Message[], question?: string): Promise<string | undefined> => {
    if (!advisorModel || advisorUsed >= (o.advisorCap ?? 4)) return undefined;
    advisorUsed++;
    const task = msgs.find((m) => m.role === "user")?.content ?? "", audit = ledger.audit(task);
    let diff = ""; try { diff = (await runShell("git diff --stat && git diff", o.cwd, 15_000)).replace(/^exit=0\n?/, ""); } catch { /* not a repository */ }
    const packet = buildPacket({ messages: msgs, why, question, changed: audit.changed, auditNotes: audit.notes, diff });
    try {
      const t0 = Date.now(), m = await advisorModel([{ role: "system", content: ADVISOR_SYSTEM }, { role: "user", content: clip(packet, 20_000) }], []);
      o.budget?.add(m, advisorModel.card, Date.now() - t0);
      return clip((m.content ?? "").trim(), 2500) || undefined;
    } catch { return undefined; }
  };
  if (advisorModel) registry.add(defineTool<{ question: string }>({ name: "advise", readOnly: true,
    description: "Ask a stronger model for advice (a plan, a correction, a risk you are missing). It sees a summary of the task and your work so far, not your files. A few times per request.",
    schema: { type: "object", required: ["question"], properties: { question: { type: "string", description: "what you want advice on" } } },
    run: async ({ question }, ctx) => (await consult("the engineer asked a question", [...(ctx.messages ?? [])], question)) ?? `(no advice: the advisor was not reachable, or it was already asked ${o.advisorCap ?? 4} times for this request)` }));
  const reviewModel: Model = (typeof o.review === "object" && o.review.model) || o.models?.review || o.model;
  let contract: string[] = [];
  /** Acceptance criteria for a task-like message (reviewer on): written first, shown to the builder, checked at the end. */
  const withContract = async (text: string, force = false): Promise<string> => {
    if (!o.review) return text;
    contract = [];
    if (!force && !(text.length >= 25 && /\b(fix|add|implement|refactor|change|update|create|write|build|make|rename|remove|migrate|optimi[sz]e|support|bug|test|handle)/i.test(text))) return text;
    contract = await proposeContract(reviewModel, text, o.budget);
    return contract.length ? `${text}\n\n## Acceptance criteria (an independent reviewer will check these before your work is accepted)\n${contract.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : text;
  };
  const sessionFile = resolve(o.cwd, ".amness/handoff.md");
  let task = "";
  const h = createHarness({
    model: o.model, toolCache, finishChecks: [coverageCheck, auditCheck(o.cwd, () => codeIndex, () => [...created])], compactSpecs: () => o.compactSchemas ?? lean(), compactModel: o.models?.compact, system: SYS(o.chat), tools: registry, maxSteps: o.maxSteps ?? (o.chat ? 60 : 40), inbox: o.inbox,
    budget: o.budget, stableTools: o.stableTools, ladder: o.ladder, textToolCalls: o.textToolCalls, hollow: (name, args) => hollowWhy(o.cwd, name, args), reread: localTier() && !o.review, advise: advisorModel ? (why, msgs) => consult(why === "start" ? "the engineer is about to make the first change" : why === "stuck" ? "the engineer seems stuck: recent steps failed or changed nothing measurable" : "the engineer is about to declare the task done", msgs) : undefined, approve, policy: policyFn, context: plugins.some((p) => p.context) ? async (m, info) => { let cur = m, changed = false; for (const p of plugins) if (p.context) { const r = await p.context(cur, info); if (Array.isArray(r) && r.length) { cur = r; changed = true; } } return changed ? cur : undefined; } : undefined, off: o.off, onEvent: o.onEvent, signal: o.signal, record: o.record, governRewrites: o.governRewrites, cachedPrice: o.cachedPrice, cacheTtlMs: o.cacheTtlMs, contextBudget: o.contextBudget, redact: o.redact !== false, taint: o.taint ?? "ask", hooks: o.hooks, toolChoice: o.chat ? "auto" : o.toolChoice, thinkingBudget: o.thinkingBudget, request: o.request, keepThinking: o.keepThinking, quarantine: o.quarantine ? plugins.find((p) => p.quarantine)?.quarantine ?? (typeof o.quarantine === "function" ? o.quarantine : quarantineReader(o.models?.cheap ?? o.model)) : undefined, stagnationTurns: o.stagnationTurns, ledger, reviewer: o.review ? (ctx) => reviewWork({ model: reviewModel, cwd: o.cwd, task: ctx.task, contract, summary: ctx.summary, diffs: ledger.diffs(), commands: ledger.recentCommands(), verify: o.verify, budget: o.budget, signal: typeof o.signal === "function" ? o.signal() : o.signal }) : undefined, permissions: o.rules === false ? undefined : o.rules ?? new Permissions({}, o.cwd),
    rollover: o.rollover === false ? undefined : o.rollover ?? { afterTokens: 120_000, afterChars: 500_000 }, contextWindow: o.contextWindow, onWindow: o.onWindow,
    onHandoff: (note) => { mkdirSync(dirname(sessionFile), { recursive: true }); writeFileSync(sessionFile, `# Handoff

Task: ${task}

${note}
`); },
    verify: o.verify ? async () => {
      const out = await runShell(o.verify!, o.cwd, 300_000);
      return out.startsWith("exit=0") ? true : `\`${o.verify}\` failed:\n${clip(out, 3000)}`;
    } : undefined,
    checkpoint: o.checkpointFile ? (m) => { mkdirSync(dirname(resolve(o.checkpointFile!)), { recursive: true }); writeFileSync(o.checkpointFile!, JSON.stringify(m)); } : undefined,
  });
  return {
    /** The live toolbox: add/remove tools between or during runs. */
    registry, memory, guidance, procs, lsp, codeIndex, toolCache, plans, get agents() { return agentList; }, get agentWarnings() { return agentWarnings; }, get skills() { return skillList; }, get allSkills() { return allSkillList; }, skillState, rescanSkills: () => rescan(), draftSkill: (messages: Message[]) => draftSkill(o.cwd, o.models?.compact ?? o.model, messages), get skillWarnings() { return skillWarnings; },
    /** Keep the provider's prompt cache alive across an idle gap (see createHarness().warm). */
    warm: (msgs: Message[], opts?: { signal?: AbortSignal }) => h.warm(msgs, opts),
    get todos() { return todos; },
    /** One conversational turn: `history` is everything so far (empty to start); returns the updated transcript in `messages`. */
    async chat(history: Message[], userText: string, extra: { images?: { mime: string; data: string }[] } = {}) {
      tasksThisRequest = 0; advisorUsed = 0;
      task ||= userText;
      let text = userText;
      // Small talk ("hi", "thanks") goes as it is: the project guidance, skills and memory notes would only send the model looking for work.
      // They come with the first real request instead, so saying hi first does not lose them.
      const chatty = isSmallTalk(userText), first = !chatty && !history.some((m) => m.role === "user" && !isSmallTalk(m.content ?? ""));
      const gate = await promptHooks(history.length === 0, userText); if (gate.block) return { text: gate.block, finished: false, steps: 0, messages: history, stopped: "blocked" as const, tokens: 0 };
      if (gate.context) text += "\n\n" + gate.context;
      text = await withContract(text);
      if (memory?.embedder && !chatty) { await memory.index().catch(() => {}); await memory.warmQuery(userText); }
      if (first && guidance) { const g = guidance.start(); if (g) text += "\n\n" + g; }
      if (first) { rescanIndex(); rescanAgents(); rescan(); const sb = skillBlockFor(userText); if (sb) text += "\n\n" + sb; }
      if (first && backend) { shown.clear(); const ctx = backend.context(userText, small() ? 800 : 6000, shown); if (ctx) text += "\n\n" + ctx; }
      else if (backend && !chatty) { const d = backend.delta(userText, shown); if (d) text += "\n\n" + d; }          // only new, relevant notes, at the end: the cached prefix stays intact
      const img = extra.images?.length ? { images: extra.images } : {};
      const msgs: Message[] = history.length ? [...history, { role: "user", content: text, ...img }]
        : [{ role: "system", content: SYS(o.chat) }, { role: "user", content: text, ...img }];
      const res = await h.run(text, { resume: msgs });
      // Learning from outcomes: a finished (verified) run credits the notes that were in front of the model, a run that gave up or got stuck counts against them.
      backend?.endTurn(res.finished ? true : res.stopped && res.stopped !== "aborted" ? false : undefined);
      if (loadedSkills.size) { const ok = res.finished ? true : res.stopped && res.stopped !== "aborted" ? false : undefined; if (ok !== undefined) skillState.outcome([...loadedSkills], ok); loadedSkills.clear(); }      // a finished run counts for the skills it used, a run that gave up counts against; a plain chat reply counts neither way
      return res;
    },
    async run(t: string, opts: RunOptions = {}) {
      tasksThisRequest = 0; advisorUsed = 0;
      task = t;
      let resume = opts.resume && o.checkpointFile && existsSync(o.checkpointFile) ? (JSON.parse(readFileSync(o.checkpointFile, "utf8")) as Message[]) : undefined;
      // resuming with a NEW instruction: add it as a follow-up rather than silently ignoring it
      if (resume && t.trim() && !(resume.find((m) => m.role === "user")?.content ?? "").startsWith(t.trim())) resume = [...resume, { role: "user", content: t }];
      let prompt = t;
      const gate = await promptHooks(!resume, t); if (gate.block) return { text: gate.block, finished: false, steps: 0, messages: resume ?? [], stopped: "blocked" as const, tokens: 0 };
      if (gate.context) prompt += "\n\n" + gate.context;
      prompt = await withContract(prompt, true);
      if (opts.bundle) {
        const b = typeof opts.bundle === "string" ? readBundle(opts.bundle) : opts.bundle;
        const r = applyBundle(b, { cwd: o.cwd, memory, overwrite: opts.overwrite });
        prompt = `${t || b.task}\n\n## Handoff from a previous session (possibly another machine or model)\nOriginal task: ${b.task}\nStatus then: ${b.status.finished ? "finished" : "unfinished"}${b.status.summary ? ` - ${b.status.summary}` : ""}\n${b.handoff}\n\nRestored ${r.restored.length} file(s) from that session${r.skipped.length ? `; kept your version of: ${r.skipped.join(", ")}` : ""}. Re-check the workspace before continuing; it may have changed.`;
      }
      if (guidance && !resume) { const g = guidance.start(); if (g) prompt += "\n\n" + g; }
      if (!resume) { rescanIndex(); rescan(); const sb = skillBlockFor(t); if (sb) prompt += "\n\n" + sb; }
      if (backend && !resume) { const ctx = backend.context(prompt, small() ? 800 : 6000); if (ctx) prompt += "\n\n" + ctx; }
      const offered = plans && !resume && t.trim() ? plans.find(t) : undefined;
      if (offered) { prompt += "\n\n" + planBlock(offered.plan, offered.similarity); o.onEvent?.({ kind: "plan", detail: `offered a plan from a similar task (${Math.round(offered.similarity * 100)}% similar)` }); }
      if (opts.images?.length && !resume) resume = [{ role: "system", content: SYS(o.chat) }, { role: "user", content: prompt, images: opts.images }];
      const res = await h.run(prompt, { resume });
      backend?.endTurn(res.finished ? true : res.stopped && res.stopped !== "aborted" ? false : undefined);
      if (loadedSkills.size) { const ok = res.finished ? true : res.stopped && res.stopped !== "aborted" ? false : undefined; if (ok !== undefined) skillState.outcome([...loadedSkills], ok); loadedSkills.clear(); }      // a finished run counts for the skills it used, a run that gave up counts against; a plain chat reply counts neither way
      if (plans && !resume && t.trim()) { if (offered) plans.outcome(offered.plan.id, res.finished); if (res.finished) plans.record(t, planFrom(res.messages, res.text)); }
      return res;
    },
    /** Keep talking to the agent after it finished (or stopped): same conversation, full context. */
    followUp(prev: { messages: Message[] }, text: string) {
      return h.run(text, { resume: [...prev.messages, { role: "user", content: text }] });
    },
    /** Replace a long conversation by a model-written handoff note (same mechanism as automatic rollover, on demand). */
    async compact(messages: Message[]): Promise<{ messages: Message[]; note: string }> {
      const specs = registry.visible({ step: 0, messages }).map((t) => ({ name: t.name, description: t.description, parameters: t.schema }));
      const note = await makeHandoff(o.models?.compact ?? o.model, specs, messages, o.budget);
      const msgs = messages.some((m) => m.role === "user") ? messages : [...messages, { role: "user" as const, content: task }];
      return { note, messages: [messages[0], { role: "user", content: handoffSeed(msgs, note, o.off?.includes("pin") ? null : pinRules) }] };
    },
    /** Package the work so far for another machine / model / day. Asks the model for a handoff note unless one is supplied. */
    async exportBundle(result: { messages: Message[]; finished: boolean; text: string }, path?: string, handoff?: string): Promise<{ bundle: Bundle; path?: string }> {
      const note = handoff ?? (await makeHandoff(o.models?.compact ?? o.model, registry.visible({ step: 0, messages: result.messages }).map((t) => ({ name: t.name, description: t.description, parameters: t.schema })), result.messages, o.budget));
      const bundle: Bundle = {
        schema: "amness.session/1", createdAt: new Date().toISOString(), task: result.messages.find((m) => m.role === "user")?.content?.split("\n\n## ")[0] ?? task,
        status: { finished: result.finished, summary: result.text.slice(0, 500) }, handoff: note, memory: backend?.list() ?? [],
        files: collectFiles(o.cwd, touched), from: { ...o.meta, cwd: basename(resolve(o.cwd)) },
      };
      return { bundle, path: path ? writeBundle(path, bundle) : undefined };
    },
  };
}

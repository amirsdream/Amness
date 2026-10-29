import { exec, execFile } from "node:child_process";
import { wrapCommand, type SandboxMode } from "./sandbox.ts";
import { childEnv } from "./secrets.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { applyBundle, collectFiles, readBundle, writeBundle, type Bundle } from "./bundle.ts";
import { unifiedDiff } from "./diff.ts";
import { createToolTool, loadSavedTools } from "./dynamic.ts";
import { createHarness, defineTool, clip, makeHandoff, Registry, type ToolCtx, type Approve, type Budget, type Event, type Guard, type Message, type Model, type Tool } from "./harness.ts";
import { MemoryStore, isMemoryBackend, memoryTools, type MemoryBackend } from "./memory.ts";
import type { Embedder } from "./embed.ts";
import { Guidance } from "./guidance.ts";
import { posixShell, slash } from "./shell.ts";
import { ProcessManager } from "./procs.ts";
import { reviewedApprove } from "./approver.ts";
import { Diagnostics, type LspServer } from "./lsp.ts";
import { Ledger } from "./ledger.ts";
import { CodeIndex, indexTools } from "./codeindex.ts";
import { AGENT_TOOLS, WRITE_TOOLS, isWriter, loadAgents, type AgentDef } from "./agents.ts";
import type { Roles } from "./route.ts";
import { applyDiff, createWorktree, isRepo, removeWorktree, worktreeDiff, type Worktree } from "./worktree.ts";
import { loadSkills, skillsBlock, skillTool, type Skill } from "./skills.ts";
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

export function runShell(cmd: string, cwd: string, ms = 60_000, signal?: AbortSignal, sandbox: SandboxMode = "off"): Promise<string> {
  let wrapped: ReturnType<typeof wrapCommand>;
  try { wrapped = wrapCommand(cmd, cwd, sandbox); } catch (e) { return Promise.resolve(`exit=126\nERROR: ${(e as Error).message}`); }          // asked for a sandbox we cannot provide: refuse, never run unprotected
  const done = (err: any, out: string, errOut: string) => `exit=${err ? (err.name === "AbortError" ? "interrupted" : err.killed ? "timeout" : err.code ?? 1) : 0}\n${out}${errOut}`;
  return new Promise((res) => wrapped
    ? execFile(wrapped.file, wrapped.args, { cwd, env: childEnv(process.env, true), timeout: ms, maxBuffer: 10 << 20, signal }, (err: any, out, errOut) => res(done(err, out, errOut)))
    : exec(cmd, { cwd, shell: process.platform === "win32" ? posixShell() : undefined, env: childEnv(), timeout: ms, maxBuffer: 10 << 20, signal }, (err: any, out, errOut) => res(done(err, out, errOut))));
}

/** File + shell tools confined to `cwd`. Enforces read-before-edit; flags dangerous shell commands as risky. */
export function codeTools(cwd: string, o: { /** called before a command that may change files runs (snapshots, irreversibility notes) */ beforeShell?: (cmd: string) => Promise<void>; /** OS sandbox for shell commands, read each time so it can be switched live */ sandbox?: () => SandboxMode; /** background processes (sh_start, sh_read, sh_stop, sh_list) */ procs?: ProcessManager; /** folder-level instruction files, appended to results the first time the agent works in that folder */ guidance?: Guidance; onChange?: (path: string) => void; mode?: () => PermMode; /** Run after each successful edit; returns text to append to the tool result (empty when all is well). */ check?: (paths: string[]) => Promise<string> } = {}): Tool[] {
  const mode = o.mode;
  const mutating = mode ? { risky: () => (mode() === "default" ? "modify a file" : false), when: () => mode() !== "plan" } : {};
  const root = resolve(cwd);
  const shRisk = ({ cmd }: { cmd: string }): string | false => (!mode ? riskOf(cmd) : mode() === "yolo" ? false : riskOf(cmd) || (READONLY_CMD.test(cmd) ? false : "run a shell command"));
  const readSet = new Set<string>();
  const patchText = (a: { patch?: string; file?: string }): string => { if (a.patch) return a.patch; if (!a.file) throw new Error("give `patch` or `file`"); return readFileSync(abs(a.file), "utf8"); };
  const abs = (p: string) => {
    const a = resolve(root, p);
    if (a !== root && !a.startsWith(root + sep)) throw new Error(`path escapes the workspace: ${p}`);
    return a;
  };
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
    defineTool<{ path?: string }>({ name: "list_files", description: "List files in the workspace (skips node_modules, .git, dist). Max 300.",
      schema: { type: "object", properties: { path: { type: "string" } } }, readOnly: true,
      run: ({ path }) => walk(abs(path ?? "."), []).join("\n") || "(empty)" }),
    defineTool<{ path: string; start?: number; end?: number }>({ name: "read_file", description: "Read a file with line numbers (optionally lines start..end).",
      schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } } }, readOnly: true,
      run: ({ path, start, end }) => {
        const a = abs(path); if (!existsSync(a)) throw new Error(`no such file: ${path}.${suggest(path)}`); readSet.add(a);
        const all = readFileSync(a, "utf8").split("\n"); if (all.at(-1) === "") all.pop();            // a trailing newline is not an extra empty line
        return all.slice((start ?? 1) - 1, end).map((l, i) => `${(start ?? 1) + i}\t${l}`).join("\n") + (o.guidance?.nested(path) ?? "");
      } }),
    defineTool<{ pattern: string; path?: string }>({ name: "grep", description: "Recursive regex search (file:line:text). Counts as having read matching files.",
      schema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" }, path: { type: "string" } } }, readOnly: true,
      run: ({ pattern, path }) => path && !existsSync(abs(path)) ? `ERROR: ${path} does not exist, so nothing was searched.${suggest(path)}` : new Promise<string>((res) => execFile("grep", ["-rnIE", "-m", "20", ...[...IGNORE].map((d) => `--exclude-dir=${d}`), "-e", pattern, path ?? "."],
        { cwd: root, maxBuffer: 10 << 20 }, (_e, out) => {
          for (const l of out.split("\n")) { const f = l.split(":")[0]; if (f) { try { readSet.add(abs(f)); } catch { /* outside */ } } }
          res(out.split("\n").slice(0, 100).join("\n") || "no matches");
        })) }),
    defineTool<{ path: string; content: string }>({ name: "write_file", description: "Create a file, or fully overwrite one you have already read.",
      schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } }, ...mutating,
      preview: ({ path, content }) => unifiedDiff(path, existsSync(abs(path)) ? readFileSync(abs(path), "utf8") : null, content).diff,
      run: async ({ path, content }, ctx) => {
        mustRead(path);
        const a = abs(path), before = existsSync(a) ? readFileSync(a, "utf8") : null;
        mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, content); readSet.add(a); o.onChange?.(path);
        ctx.emit?.({ kind: "edit", ...unifiedDiff(path, before, content), before: before === null || before.length < 500_000 ? before : undefined });
        return `wrote ${content.length} chars to ${path}` + (await o.check?.([path]) ?? "") + (o.guidance?.nested(path) ?? "");
      } }),
    defineTool<{ path: string; old?: string; new?: string; edits?: { old: string; new: string }[] }>({ name: "edit_file", description: "Replace exact, unique text in a file you have read. Give `old` and `new`, or an `edits` list of several replacements applied in order (all or nothing). If the text differs only in indentation it is still matched when unique. Shows the result.",
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
    defineTool<{ patch?: string; file?: string }>({ name: "apply_patch", description: "Change several files at once with a patch, all or nothing. Format: `*** Begin Patch`, then per file `*** Update File: path` (hunks start with `@@`, lines begin with space, `-` or `+`), `*** Add File: path` (all lines start with `+`) or `*** Delete File: path`, then `*** End Patch`. A unified diff also works. Existing files must have been read first. Instead of `patch` you can pass `file`: a patch file inside the workspace (a subagent's saved result).",
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
          o.onChange?.(x.path);
          const ch = unifiedDiff(x.path, x.before, x.after ?? "");
          ctx.emit?.({ kind: "edit", ...ch, before: x.before === null || x.before.length < 500_000 ? x.before : undefined });
          lines.push(`${x.after === null ? "deleted" : x.before === null ? "added" : "updated"} ${x.path} (+${ch.added} -${ch.removed})${x.fuzzy ? `, ${x.fuzzy} hunk(s) matched ignoring indentation` : ""}`);
        }
        return `patched ${r.applied.length} file(s):\n${lines.join("\n")}` + (await o.check?.(r.applied.filter((x) => x.after !== null).map((x) => x.path)) ?? "") + (o.guidance?.nested(r.applied[0].path) ?? "");
      } }),
    ...(o.procs ? bgTools(o.procs, shRisk, mode) : []),
    defineTool<{ cmd: string; timeout?: number }>({ name: "sh", description: "Run a shell command in the workspace; returns exit code and output. Dangerous commands need human approval.",
      schema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" }, timeout: { type: "integer", description: "seconds, default 60" } } },
      risky: shRisk,
      preview: ({ cmd }) => cmd,
      run: async ({ cmd, timeout }, ctx) => {
        if (mode?.() === "plan" && !READONLY_CMD.test(cmd))
          return "ERROR: plan mode is read-only; only inspection commands are allowed (ls, cat, head, tail, grep, find, git status/log/diff/show, wc, pwd). Finish your plan and call exit_plan_mode.";
        if (o.beforeShell && !READONLY_CMD.test(cmd)) { try { await o.beforeShell(cmd); } catch { /* a failed snapshot must not stop the command */ } }
        return runShell(cmd, root, (timeout ?? 60) * 1000, ctx.signal, o.sandbox?.() ?? "off");
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
export const CHAT_SYSTEM = `You are an expert software engineer pair-programming with the user in their terminal, inside their repository. Be concise and direct; format with Markdown (short paragraphs, \`inline code\`, fenced code blocks).
How to work:
- Questions: answer from the code. Explore first (list_files, grep, read_file; in a large repository start with repo_map, find_refs and impact when you have them) instead of guessing; cite files as path:line. Use the \`task\` tool for broad searches so your own context stays clean.
- Effort: match effort to the question. A fact or one-file question: 3-10 tool calls, no subagent. Comparing or tracing a few things: 10-15 calls. Only a genuinely broad survey justifies \`task\`, and then give each subagent a distinct slice. When your budget notes say it is running low, stop exploring and give the best answer you have, saying what you did not cover.
- Changes: read a file before editing it, make the smallest correct change, then verify it (run the tests/build). For anything with 3+ steps, keep a checklist with \`todo_write\` and update it as you go (exactly one item in_progress).
- When you finish a coding task, call \`finish(summary)\` (what changed, how you verified). For plain questions just answer; no \`finish\` needed.
- Permissions: the user may be asked to approve edits and shell commands. If a call is denied, do not retry it; use another approach or explain what you need. In plan mode you are read-only: investigate, then present a plan with \`exit_plan_mode\` and wait for approval.
- If the request is ambiguous in a way that matters, ask ONE short clarifying question; otherwise choose sensible defaults and say what you assumed.
- Notes from earlier sessions may appear below the user's message; treat them as hints to verify. Save durable, non-obvious lessons with memory_save (never secrets).
- Servers and watchers: start them with \`sh_start\` (plain \`sh\` waits for the command to end), read their output with \`sh_read\`, and \`sh_stop\` them when you are done.
- Never invent file contents or command output. The user can type while you work; their new messages arrive between your steps, so adjust course when they do.`;

const EXPLORE_SYSTEM = `You are a read-only code explorer working for another engineer. Investigate the question using list_files, read_file, grep and read-only shell commands. You have a small budget (about 12 tool calls): ask for the most informative things first (grep, then read only the relevant ranges), do not read whole files you do not need, and stop as soon as you can answer. If the question is too broad, answer what you can and say what you did not cover. Report concisely (under 300 words): the answer, the relevant files with line numbers, and anything surprising. You cannot change anything. Finish with \`finish(summary)\`; the requester sees only that summary.`;

export type CodeAgentOptions = {
  /** Conversational mode (the TUI): chat prompt, plus todo_write, task (read-only explorer subagent) and exit_plan_mode tools. */
  chat?: boolean;
  /** Live permission mode. When given, edits and shell commands ask for approval per the mode (see PermMode); omit for the autonomous behaviour. */
  permissions?: { mode: () => PermMode };
  /** Polled every turn for messages the user typed while the agent works. */
  inbox?: () => string[];
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
  const SYS = (chat: boolean | undefined) => applySystem(plugins, chat ? CHAT_SYSTEM : CODE_SYSTEM, o.cwd);
  const toolsFile = resolve(o.cwd, ".amness/tools.json");
  const touched = new Set<string>();
  const guidance = o.guidance === false ? undefined : new Guidance(o.cwd);
  const sbx = o.sandbox, sandboxMode: () => SandboxMode = typeof sbx === "function" ? sbx : () => sbx ?? "off";
  let agentList: AgentDef[] = []; const agentWarnings: string[] = []; let patchCount = 0;
  const agentOf = (name?: string) => (name && name !== "explore" ? agentList.find((a) => a.name === name) : undefined);
  const rescanAgents = () => { if (o.agents === false) return; const r = loadAgents(o.cwd); agentList = r.agents; agentWarnings.splice(0, agentWarnings.length, ...r.warnings); };
  rescanAgents();
  let tasksThisRequest = 0; const MAX_SUBAGENTS_PER_REQUEST = 6;
  let taskSlots = 3; const taskWaiters: (() => void)[] = [];
  const acquireTask = async () => { if (taskSlots > 0) { taskSlots--; return; } await new Promise<void>((r) => taskWaiters.push(r)); };
  const releaseTask = () => { const w = taskWaiters.shift(); if (w) w(); else taskSlots++; };
  const codeIndex = o.index === false ? undefined : new CodeIndex(o.cwd), indexMin = typeof o.index === "object" ? o.index.minFiles ?? 25 : 25;
  let skillList: Skill[] = []; const skillWarnings: string[] = [];
  const rescan = () => { if (o.skills === false) return; const r = loadSkills(o.cwd); skillList = r.skills; skillWarnings.splice(0, skillWarnings.length, ...r.warnings); if (skillList.length && !registry.get("skill")) registry.add(skillTool(() => skillList)); };
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
  const registry = new Registry(wrap([...codeTools(o.cwd, { guidance, procs, beforeShell: o.beforeShell, sandbox: sandboxMode, onChange: (p) => touched.add(p), mode, check: postEdit }), ...(backend ? memoryTools(backend) : []), ...(o.tools ?? [])]));
  const shown = new Set<string>();   // memory notes already in this conversation
  const rescanIndex = () => { if (codeIndex && !registry.get("repo_map") && codeIndex.list().length >= indexMin) registry.add(...indexTools(codeIndex)); };
  rescan(); rescanIndex();
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
      defineTool<{ description: string; agent?: string }>({
        name: "task", readOnly: true, parallel: true, concurrent: ({ agent }) => { const d = agentOf(agent); return !d || !isWriter(d) || d.isolation === "worktree"; },
        get description() { return `Delegate work to a subagent with its own fresh context: it sees only your brief and returns only its summary, so the brief must state the objective, where to look, what NOT to cover (so parallel subagents do not repeat each other) and what to report. Default: a read-only explorer for broad searches or questions that need reading many files; at most 3 run at once. Do not delegate what one grep or read would answer: a subagent costs a full session of tokens.${agentList.length ? ` Other agents (pass \`agent\`): ${agentList.map((a) => `${a.name}: ${a.description}${isWriter(a) ? (a.isolation === "worktree" ? " [edits in an isolated copy and returns a patch]" : " [can edit files]") : ""}`).join("; ")}.` : ""}`; },
        schema: { type: "object", required: ["description"], properties: { description: { type: "string", description: "complete brief: the question or job, where to look, what to report" }, agent: { type: "string", description: "which agent (default: the read-only explorer)" } } },
        run: async (args, ctx) => { await acquireTask(); try { return await runTask(args, ctx); } finally { releaseTask(); } },
      }),
      defineTool<{ plan: string }>({
        name: "exit_plan_mode", readOnly: true, risky: true, when: () => mode?.() === "plan", preview: ({ plan }) => plan,
        description: "Plan mode only: present your finished plan to the user for approval. After approval you can edit files.",
        schema: { type: "object", required: ["plan"], properties: { plan: { type: "string", description: "the plan, in Markdown: what you will change and why, in order" } } },
        run: () => "The user approved the plan. Implement it now.",
      }),
    );
  }
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
            const r = await createHarness({ model: o.models?.explore ?? o.model, system: EXPLORE_SYSTEM, tools: codeTools(o.cwd, { mode: () => "plan" }), maxSteps: 14, policy: policyFn, budget: track(o.budget?.slice(0.12, 60_000)), signal: ctx.signal, onEvent: emitAs("explore") }).run(description);
            const note = unknown ? `(no agent named "${unknown}"; the read-only explorer answered. Available: explore${agentList.map((a) => ", " + a.name).join("")})\n` : "";
            return note + clip(r.text || "(the explorer returned nothing)", 8000);                 // subagents hand back a condensed result (Anthropic: 1-2k tokens), never their working notes
          }
          const names = plan ? d.tools.filter((t) => !WRITE_TOOLS.has(t)) : d.tools, isolated = d.isolation === "worktree" && isWriter(d) && !plan;
          let wt: Worktree | undefined; if (isolated) { if (!(await isRepo(o.cwd))) return "ERROR: isolation: worktree needs a git repository with at least one commit"; wt = await createWorktree(o.cwd); }
          try {
            const base = codeTools(wt?.dir ?? o.cwd, { mode: plan ? () => "plan" : (mode ?? (() => "default")), sandbox: sandboxMode }).filter((t) => names.includes(t.name));
            if (names.includes("skill") && skillList.length) base.push(skillTool(() => skillList));
            const r = await createHarness({
              model: (d.model && o.agentModels?.[d.model]) || o.model, system: `${d.prompt}\n\nYou are a subagent working for another engineer. You see only the brief below. Finish with \`finish(summary)\`: what you found or did, concretely, with file paths.`, tools: base, maxSteps: d.maxSteps,
              budget: track(o.budget?.slice(0.25, 120_000)), signal: ctx.signal, approve, permissions: o.rules === false ? undefined : o.rules ?? new Permissions({}, wt?.dir ?? o.cwd), policy: policyFn, hooks: o.hooks, ledger: isolated ? undefined : isWriter(d) ? ledger : undefined, onEvent: emitAs(d.name),
            }).run(description);
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
    model: o.model, compactModel: o.models?.compact, system: SYS(o.chat), tools: registry, maxSteps: o.maxSteps ?? (o.chat ? 60 : 40), inbox: o.inbox,
    budget: o.budget, approve, policy: policyFn, context: plugins.some((p) => p.context) ? async (m, info) => { let cur = m, changed = false; for (const p of plugins) if (p.context) { const r = await p.context(cur, info); if (Array.isArray(r) && r.length) { cur = r; changed = true; } } return changed ? cur : undefined; } : undefined, off: o.off, onEvent: o.onEvent, signal: o.signal, record: o.record, redact: o.redact !== false, taint: o.taint ?? "ask", hooks: o.hooks, stagnationTurns: o.stagnationTurns, ledger, reviewer: o.review ? (ctx) => reviewWork({ model: reviewModel, cwd: o.cwd, task: ctx.task, contract, summary: ctx.summary, diffs: ledger.diffs(), commands: ledger.recentCommands(), verify: o.verify, budget: o.budget, signal: typeof o.signal === "function" ? o.signal() : o.signal }) : undefined, permissions: o.rules === false ? undefined : o.rules ?? new Permissions({}, o.cwd),
    rollover: o.rollover === false ? undefined : o.rollover ?? { afterTokens: 120_000, afterChars: 500_000 },
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
    registry, memory, guidance, procs, lsp, codeIndex, get agents() { return agentList; }, get agentWarnings() { return agentWarnings; }, get skills() { return skillList; }, get skillWarnings() { return skillWarnings; },
    /** Keep the provider's prompt cache alive across an idle gap (see createHarness().warm). */
    warm: (msgs: Message[], opts?: { signal?: AbortSignal }) => h.warm(msgs, opts),
    get todos() { return todos; },
    /** One conversational turn: `history` is everything so far (empty to start); returns the updated transcript in `messages`. */
    async chat(history: Message[], userText: string, extra: { images?: { mime: string; data: string }[] } = {}) {
      tasksThisRequest = 0;
      task ||= userText;
      let text = userText;
      const gate = await promptHooks(history.length === 0, userText); if (gate.block) return { text: gate.block, finished: false, steps: 0, messages: history, stopped: "blocked" as const, tokens: 0 };
      if (gate.context) text += "\n\n" + gate.context;
      text = await withContract(text);
      if (memory?.embedder) { await memory.index().catch(() => {}); await memory.warmQuery(userText); }
      if (!history.length && guidance) { const g = guidance.start(); if (g) text += "\n\n" + g; }
      if (!history.length) { rescanIndex(); rescanAgents(); rescan(); const sb = skillsBlock(skillList); if (sb) text += "\n\n" + sb; }
      if (!history.length && backend) { shown.clear(); const ctx = backend.context(userText, 6000, shown); if (ctx) text += "\n\n" + ctx; }
      else if (backend) { const d = backend.delta(userText, shown); if (d) text += "\n\n" + d; }          // only new, relevant notes, at the end: the cached prefix stays intact
      const img = extra.images?.length ? { images: extra.images } : {};
      const msgs: Message[] = history.length ? [...history, { role: "user", content: text, ...img }]
        : [{ role: "system", content: SYS(o.chat) }, { role: "user", content: text, ...img }];
      const res = await h.run(text, { resume: msgs });
      // Learning from outcomes: a finished (verified) run credits the notes that were in front of the model, a run that gave up or got stuck counts against them.
      backend?.endTurn(res.finished ? true : res.stopped && res.stopped !== "aborted" ? false : undefined);
      return res;
    },
    async run(t: string, opts: RunOptions = {}) {
      tasksThisRequest = 0;
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
      if (!resume) { rescanIndex(); rescan(); const sb = skillsBlock(skillList); if (sb) prompt += "\n\n" + sb; }
      if (backend && !resume) { const ctx = backend.context(prompt); if (ctx) prompt += "\n\n" + ctx; }
      if (opts.images?.length && !resume) resume = [{ role: "system", content: SYS(o.chat) }, { role: "user", content: prompt, images: opts.images }];
      const res = await h.run(prompt, { resume });
      backend?.endTurn(res.finished ? true : res.stopped && res.stopped !== "aborted" ? false : undefined);
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
      const first = (messages.find((m) => m.role === "user")?.content ?? task).split("\n\n## Handoff from your earlier context")[0];
      return { note, messages: [messages[0], { role: "user", content: `${first}\n\n## Handoff from your earlier context (you are continuing, not starting over)\n${note}` }] };
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

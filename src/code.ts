import { exec, execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { applyBundle, collectFiles, readBundle, writeBundle, type Bundle } from "./bundle.ts";
import { unifiedDiff } from "./diff.ts";
import { createToolTool, loadSavedTools } from "./dynamic.ts";
import { createHarness, defineTool, clip, makeHandoff, Registry, type Approve, type Budget, type Event, type Guard, type Message, type Model, type Tool } from "./harness.ts";
import { MemoryStore, memoryTools } from "./memory.ts";

const RISKY: [RegExp, string][] = [
  [/\brm\s+(-\w*[rf]|--recursive|--force)/, "recursive/forced delete"], [/\bsudo\b/, "sudo"],
  [/\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D|rebase)/, "destructive or outward git operation"],
  [/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh/, "pipes a download into a shell"],
  [/\b(npm|pnpm|yarn)\s+(publish|login)|\b(pip|pip3|npm|pnpm|yarn|brew|apt(-get)?|cargo)\s+(install|add|i)\b/, "installs or publishes packages"],
  [/\b(chmod|chown)\s+-R|\bdd\s+if=|\bmkfs|>\s*\/dev\/|:\(\)\s*\{/, "dangerous system command"],
  [/\b(ssh|scp|rsync)\b/, "remote access"],
];
export const riskOf = (cmd: string): string | false => RISKY.find(([re]) => re.test(cmd))?.[1] ?? false;

/** How much the agent may do without asking. default: ask for edits and non-trivial shell; acceptEdits: ask only for shell; plan: read-only; yolo: never ask. */
export type PermMode = "default" | "acceptEdits" | "plan" | "yolo";
/** Inspection-only shell commands (no chaining, redirects or substitutions): always allowed, even in plan mode. */
export const READONLY_CMD = /^\s*(ls|cat|head|tail|wc|pwd|echo|grep|rg|tree|stat|file|which|date|whoami|git\s+(status|log|diff|show|rev-parse|ls-files|blame)|find(?!.*\s-(exec|delete|ok|fprint))|node\s+--version|npm\s+(ls|list|view))(\s[^;&|<>`$()]*)?$/;

const IGNORE = new Set(["node_modules", ".git", "dist", ".amness", "__pycache__", ".venv"]);

export function runShell(cmd: string, cwd: string, ms = 60_000, signal?: AbortSignal): Promise<string> {
  return new Promise((res) =>
    exec(cmd, { cwd, timeout: ms, maxBuffer: 10 << 20, signal }, (err: any, out, errOut) =>
      res(`exit=${err ? (err.name === "AbortError" ? "interrupted" : err.killed ? "timeout" : err.code ?? 1) : 0}\n${out}${errOut}`)));
}

/** File + shell tools confined to `cwd`. Enforces read-before-edit; flags dangerous shell commands as risky. */
export function codeTools(cwd: string, o: { onChange?: (path: string) => void; mode?: () => PermMode; /** Run after each successful edit; returns text to append to the tool result (empty when all is well). */ check?: () => Promise<string> } = {}): Tool[] {
  const mode = o.mode;
  const mutating = mode ? { risky: () => (mode() === "default" ? "modify a file" : false), when: () => mode() !== "plan" } : {};
  const root = resolve(cwd);
  const readSet = new Set<string>();
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
      statSync(p).isDirectory() ? walk(p, out) : out.push(relative(root, p));
    }
    return out;
  };

  return [
    defineTool<{ path?: string }>({ name: "list_files", description: "List files in the workspace (skips node_modules, .git, dist). Max 300.",
      schema: { type: "object", properties: { path: { type: "string" } } }, readOnly: true,
      run: ({ path }) => walk(abs(path ?? "."), []).join("\n") || "(empty)" }),
    defineTool<{ path: string; start?: number; end?: number }>({ name: "read_file", description: "Read a file with line numbers (optionally lines start..end).",
      schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } } }, readOnly: true,
      run: ({ path, start, end }) => {
        const a = abs(path); readSet.add(a);
        const all = readFileSync(a, "utf8").split("\n"); if (all.at(-1) === "") all.pop();            // a trailing newline is not an extra empty line
        return all.slice((start ?? 1) - 1, end).map((l, i) => `${(start ?? 1) + i}\t${l}`).join("\n");
      } }),
    defineTool<{ pattern: string; path?: string }>({ name: "grep", description: "Recursive regex search (file:line:text). Counts as having read matching files.",
      schema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" }, path: { type: "string" } } }, readOnly: true,
      run: ({ pattern, path }) => new Promise<string>((res) => execFile("grep", ["-rnIE", "-m", "20", ...[...IGNORE].map((d) => `--exclude-dir=${d}`), "-e", pattern, path ?? "."],
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
        return `wrote ${content.length} chars to ${path}` + (await o.check?.() ?? "");
      } }),
    defineTool<{ path: string; old: string; new: string }>({ name: "edit_file", description: "Replace one exact, unique occurrence of `old` with `new` in a file you have read. Shows the result.",
      schema: { type: "object", required: ["path", "old", "new"], properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } } }, ...mutating,
      preview: ({ path, old, new: nw }) => { const s = readFileSync(abs(path), "utf8"); return s.split(old).length === 2 ? unifiedDiff(path, s, s.replace(old, () => nw)).diff : undefined; },
      run: async ({ path, old, new: nw }, ctx) => {
        mustRead(path);
        const a = abs(path), s = readFileSync(a, "utf8"), n = s.split(old).length - 1;
        if (n !== 1) return `ERROR: \`old\` matched ${n} times; it must match exactly once. Include more surrounding lines.`;
        const out = s.replace(old, () => nw);
        writeFileSync(a, out); o.onChange?.(path);
        ctx.emit?.({ kind: "edit", ...unifiedDiff(path, s, out), before: s.length < 500_000 ? s : undefined });
        const line = s.slice(0, s.indexOf(old)).split("\n").length;
        return `edited ${path}:\n` + out.split("\n").slice(Math.max(0, line - 3), line + nw.split("\n").length + 2).map((l, i) => `${Math.max(1, line - 2) + i}\t${l}`).join("\n") + (await o.check?.() ?? "");
      } }),
    defineTool<{ cmd: string; timeout?: number }>({ name: "sh", description: "Run a shell command in the workspace; returns exit code and output. Dangerous commands need human approval.",
      schema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" }, timeout: { type: "integer", description: "seconds, default 60" } } },
      risky: ({ cmd }) => !mode ? riskOf(cmd) : mode() === "yolo" ? false : riskOf(cmd) || (READONLY_CMD.test(cmd) ? false : "run a shell command"),
      preview: ({ cmd }) => cmd,
      run: ({ cmd, timeout }, ctx) => {
        if (mode?.() === "plan" && !READONLY_CMD.test(cmd))
          return "ERROR: plan mode is read-only; only inspection commands are allowed (ls, cat, head, tail, grep, find, git status/log/diff/show, wc, pwd). Finish your plan and call exit_plan_mode.";
        return runShell(cmd, root, (timeout ?? 60) * 1000, ctx.signal);
      } }),
  ];
}

export const CODE_SYSTEM = `You are an expert software engineer working autonomously in a repository. Complete the task, then call \`finish\`.
Workflow:
1. EXPLORE: list_files / grep / read_file to understand the code before changing it. Reproduce the problem or run the existing tests first when possible.
2. EDIT: smallest correct change, matching surrounding style. Prefer edit_file over rewriting files. Do not touch unrelated code. Never edit tests to make them pass unless the task says so.
3. VERIFY: run the tests/build/command that proves it works. Read failures carefully and fix the root cause. If an approach fails twice, rethink.
4. FINISH: \`finish(summary)\` with what changed, how you verified, and assumptions. It is rejected if verification fails.
MEMORY: notes from earlier sessions may appear below the task; treat them as hints to verify. When you learn something durable that is NOT obvious from the code (the real test command, a convention the user insists on, a correction), save it with memory_save. Never save secrets or task-progress chatter.
Never invent file contents or command output. Don't ask the user questions; choose sensible defaults. Some commands need human approval; if denied, use another route.`;

/** Conversational variant of the prompt: answers questions directly, plans, delegates exploration, works within permission modes. */
export const CHAT_SYSTEM = `You are an expert software engineer pair-programming with the user in their terminal, inside their repository. Be concise and direct; format with Markdown (short paragraphs, \`inline code\`, fenced code blocks).
How to work:
- Questions: answer from the code. Explore first (list_files, grep, read_file) instead of guessing; cite files as path:line. Use the \`task\` tool for broad searches so your own context stays clean.
- Changes: read a file before editing it, make the smallest correct change, then verify it (run the tests/build). For anything with 3+ steps, keep a checklist with \`todo_write\` and update it as you go (exactly one item in_progress).
- When you finish a coding task, call \`finish(summary)\` (what changed, how you verified). For plain questions just answer; no \`finish\` needed.
- Permissions: the user may be asked to approve edits and shell commands. If a call is denied, do not retry it; use another approach or explain what you need. In plan mode you are read-only: investigate, then present a plan with \`exit_plan_mode\` and wait for approval.
- If the request is ambiguous in a way that matters, ask ONE short clarifying question; otherwise choose sensible defaults and say what you assumed.
- Notes from earlier sessions may appear below the user's message; treat them as hints to verify. Save durable, non-obvious lessons with memory_save (never secrets).
- Never invent file contents or command output. The user can type while you work; their new messages arrive between your steps, so adjust course when they do.`;

const EXPLORE_SYSTEM = `You are a read-only code explorer working for another engineer. Investigate the question using list_files, read_file, grep and read-only shell commands. Report concisely: the answer, the relevant files with line numbers, and anything surprising. You cannot change anything. Finish with \`finish(summary)\`; the requester sees only that summary.`;

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
  memory?: boolean | MemoryStore;
  /** Start a fresh context with a handoff note when the transcript gets big. Default: at 120k prompt tokens / 500k chars. */
  rollover?: { afterTokens?: number; afterChars?: number } | false;
  /** Interrupt a running agent (e.g. Ctrl-C). It stops at a safe point with the checkpoint written, so it can be resumed. */
  signal?: AbortSignal | (() => AbortSignal | undefined);
  /** Recorded in exported bundles so you can see where a session came from. */
  meta?: { provider?: string; model?: string };
};

export type RunOptions = { resume?: boolean; bundle?: Bundle | string; overwrite?: boolean };

export function createCodeAgent(o: CodeAgentOptions) {
  const toolsFile = resolve(o.cwd, ".amness/tools.json");
  const touched = new Set<string>();
  const memory = o.memory === false ? undefined : o.memory instanceof MemoryStore ? o.memory : MemoryStore.forWorkspace(resolve(o.cwd));
  const mode = o.permissions?.mode;
  const registry = new Registry([...codeTools(o.cwd, { onChange: (p) => touched.add(p), mode, check: o.check ? async () => { const out = await runShell(o.check!, o.cwd, 60_000); return out.startsWith("exit=0") ? "" : `\n\n[post-edit check \`${o.check}\` failed; fix this before moving on]\n${clip(out, 1500)}`; } : undefined }), ...(memory ? memoryTools(memory) : []), ...(o.tools ?? [])]);
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
      defineTool<{ description: string }>({
        name: "task", readOnly: true, parallel: true,
        description: "Delegate an investigation to a read-only explorer subagent with its own fresh context. Give it a complete brief (it sees nothing else). Use for broad searches or questions that need reading many files; you get back only its summary. Several calls in one turn run in parallel.",
        schema: { type: "object", required: ["description"], properties: { description: { type: "string", description: "complete brief: the question, where to look, what to report" } } },
        run: async ({ description }, ctx) => {
          const r = await createHarness({
            model: o.model, system: EXPLORE_SYSTEM, tools: codeTools(o.cwd, { mode: () => "plan" }), maxSteps: 20, budget: o.budget, signal: ctx.signal,
            onEvent: (e) => o.onEvent?.({ ...e, agent: "explore" } as unknown as Event),
          }).run(description);
          return r.text || "(the explorer returned nothing)";
        },
      }),
      defineTool<{ plan: string }>({
        name: "exit_plan_mode", readOnly: true, risky: true, when: () => mode?.() === "plan", preview: ({ plan }) => plan,
        description: "Plan mode only: present your finished plan to the user for approval. After approval you can edit files.",
        schema: { type: "object", required: ["plan"], properties: { plan: { type: "string", description: "the plan, in Markdown: what you will change and why, in order" } } },
        run: () => "The user approved the plan. Implement it now.",
      }),
    );
  }
  if (o.selfExtend) { mkdirSync(dirname(toolsFile), { recursive: true }); registry.add(...loadSavedTools(toolsFile, o.cwd), createToolTool({ cwd: o.cwd, file: toolsFile })); }
  const sessionFile = resolve(o.cwd, ".amness/handoff.md");
  let task = "";
  const h = createHarness({
    model: o.model, system: o.chat ? CHAT_SYSTEM : CODE_SYSTEM, tools: registry, maxSteps: o.maxSteps ?? (o.chat ? 60 : 40), inbox: o.inbox,
    budget: o.budget, approve: o.approve, off: o.off, onEvent: o.onEvent, signal: o.signal,
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
    registry, memory,
    get todos() { return todos; },
    /** One conversational turn: `history` is everything so far (empty to start); returns the updated transcript in `messages`. */
    chat(history: Message[], userText: string) {
      task ||= userText;
      let text = userText;
      if (!history.length && memory) { const ctx = memory.context(userText); if (ctx) text += "\n\n" + ctx; }
      const msgs: Message[] = history.length ? [...history, { role: "user", content: text }]
        : [{ role: "system", content: o.chat ? CHAT_SYSTEM : CODE_SYSTEM }, { role: "user", content: text }];
      return h.run(text, { resume: msgs });
    },
    async run(t: string, opts: RunOptions = {}) {
      task = t;
      let resume = opts.resume && o.checkpointFile && existsSync(o.checkpointFile) ? (JSON.parse(readFileSync(o.checkpointFile, "utf8")) as Message[]) : undefined;
      // resuming with a NEW instruction: add it as a follow-up rather than silently ignoring it
      if (resume && t.trim() && !(resume.find((m) => m.role === "user")?.content ?? "").startsWith(t.trim())) resume = [...resume, { role: "user", content: t }];
      let prompt = t;
      if (opts.bundle) {
        const b = typeof opts.bundle === "string" ? readBundle(opts.bundle) : opts.bundle;
        const r = applyBundle(b, { cwd: o.cwd, memory, overwrite: opts.overwrite });
        prompt = `${t || b.task}\n\n## Handoff from a previous session (possibly another machine or model)\nOriginal task: ${b.task}\nStatus then: ${b.status.finished ? "finished" : "unfinished"}${b.status.summary ? ` - ${b.status.summary}` : ""}\n${b.handoff}\n\nRestored ${r.restored.length} file(s) from that session${r.skipped.length ? `; kept your version of: ${r.skipped.join(", ")}` : ""}. Re-check the workspace before continuing; it may have changed.`;
      }
      if (memory && !resume) { const ctx = memory.context(prompt); if (ctx) prompt += "\n\n" + ctx; }
      return h.run(prompt, { resume });
    },
    /** Keep talking to the agent after it finished (or stopped): same conversation, full context. */
    followUp(prev: { messages: Message[] }, text: string) {
      return h.run(text, { resume: [...prev.messages, { role: "user", content: text }] });
    },
    /** Replace a long conversation by a model-written handoff note (same mechanism as automatic rollover, on demand). */
    async compact(messages: Message[]): Promise<{ messages: Message[]; note: string }> {
      const specs = registry.visible({ step: 0, messages }).map((t) => ({ name: t.name, description: t.description, parameters: t.schema }));
      const note = await makeHandoff(o.model, specs, messages, o.budget);
      const first = (messages.find((m) => m.role === "user")?.content ?? task).split("\n\n## Handoff from your earlier context")[0];
      return { note, messages: [messages[0], { role: "user", content: `${first}\n\n## Handoff from your earlier context (you are continuing, not starting over)\n${note}` }] };
    },
    /** Package the work so far for another machine / model / day. Asks the model for a handoff note unless one is supplied. */
    async exportBundle(result: { messages: Message[]; finished: boolean; text: string }, path?: string, handoff?: string): Promise<{ bundle: Bundle; path?: string }> {
      const note = handoff ?? (await makeHandoff(o.model, registry.visible({ step: 0, messages: result.messages }).map((t) => ({ name: t.name, description: t.description, parameters: t.schema })), result.messages, o.budget));
      const bundle: Bundle = {
        schema: "amness.session/1", createdAt: new Date().toISOString(), task: result.messages.find((m) => m.role === "user")?.content?.split("\n\n## ")[0] ?? task,
        status: { finished: result.finished, summary: result.text.slice(0, 500) }, handoff: note, memory: memory?.list() ?? [],
        files: collectFiles(o.cwd, touched), from: { ...o.meta, cwd: basename(resolve(o.cwd)) },
      };
      return { bundle, path: path ? writeBundle(path, bundle) : undefined };
    },
  };
}

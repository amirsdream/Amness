// Slash commands. Each gets the running App and the raw argument string.
import { join, resolve } from "node:path";
import { collectFiles, effortsFor, loadMcp, readBundle, writeBundle, type Bundle } from "../../src/index.ts";
import { CLAUDE_MODELS, OPENAI_MODELS, PROVIDERS, type ProviderId } from "../config.ts";
import { bold, cyan, dim, green, red, yellow } from "../ui.ts";
import type { App } from "./app.ts";
import { estimateCost, fmtCost, fmtDuration, fmtTokens } from "./pricing.ts";
import { codeBlocks } from "./clipboard.ts";
import { execFile } from "node:child_process";
import { caseFromWorkspace, commitLog, createPr, currentBranch, defaultBase, diffForReview, draftPr, hasUpstream, pushBranch, reviewWork, formatMining, Hooks, Permissions, SANDBOX_MODES, cacheWaste, projectConfigFingerprint, sandboxHelp, sandboxKind, type SandboxMode } from "../../src/index.ts";
import { loadState, saveState } from "../state.ts";
import { tokenReport } from "./tokens.ts";
import { THEMES, getTheme, themeNames } from "./themes.ts";
import { helpLines, renderDiff, toolCall, todoList } from "./view.ts";

export type Cmd = { name: string; help: string; alias?: string; args?: string; /** safe to run while the agent is working */ live?: boolean; run(app: App, args: string): Promise<void> | void };

const INIT_PROMPT = "Explore this repository and write an AGENTS.md at the repo root for future coding sessions: what the project is, how to build/test/run it (exact commands), the code layout, conventions you can verify from the code, and gotchas. Keep it under 80 lines and do not invent anything you cannot confirm from the files.";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function buildCommands(): Cmd[] {
  return [
    { name: "help", alias: "?", help: "keys and commands", live: true, run: (a) => a.openPager(helpLines(a.cmds, (a.io.output.columns || 80) - 1), "help") },
    { name: "model", help: "switch model", args: "[id]", run: async (a, arg) => {
      let id: string | undefined = arg;
      if (!id) {
        const list = a.cfg.provider === "anthropic" ? CLAUDE_MODELS : a.cfg.provider === "openai" ? OPENAI_MODELS : [{ id: a.cfg.model, hint: "current" }];
        const known = list.map((m) => ({ label: m.id, value: m.id, hint: m.hint }));
        id = await a.pick("Model", [...known, { label: "Other…", value: "" }], Math.max(0, known.findIndex((m) => m.value === a.cfg.model)));
        if (id === undefined) return;
        if (id === "") { id = await a.askText("Model id", { initial: a.cfg.model }); if (!id) return; }
      }
      a.cfg.model = id;
      if (a.cfg.effort && a.cfg.provider !== "anthropic" && !effortsFor(id).includes(a.cfg.effort)) { a.say(`effort "${a.cfg.effort}" is not valid for ${id}; using the model default`, yellow); a.cfg.effort = undefined; }
      a.saveConfig(); a.buildAgent(); a.say(`model → ${cyan(id)}`, dim);
    } },
    { name: "provider", help: "switch provider (OpenAI, Claude, Ollama…)", run: async (a) => {
      const id = await a.pick<ProviderId>("Provider", (Object.keys(PROVIDERS) as ProviderId[]).map((k) => ({ label: PROVIDERS[k].label, value: k, hint: PROVIDERS[k].baseUrl })));
      if (!id) return;
      const key = id === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
      let apiKey = key;
      if (PROVIDERS[id].needsKey && !apiKey) { apiKey = await a.askText(`${PROVIDERS[id].label} API key (hidden; stored in ~/.amness/config.json, mode 600)`, { secret: true }); if (!apiKey) return; }
      Object.assign(a.cfg, { provider: id, baseUrl: PROVIDERS[id].baseUrl, model: PROVIDERS[id].model, apiKey });
      if (id === "custom" || id === "ollama") { const m = await a.askText("Model id", { initial: a.cfg.model }); if (m) a.cfg.model = m; const u = await a.askText("Base URL", { initial: a.cfg.baseUrl }); if (u) a.cfg.baseUrl = u; }
      a.saveConfig(); a.buildAgent(); a.say(`provider → ${cyan(PROVIDERS[id].label)}, model ${cyan(a.cfg.model)}`, dim);
    } },
    { name: "effort", help: "reasoning effort for the current model", args: "[level]", run: async (a, arg) => {
      const levels = a.cfg.provider === "anthropic" ? [...EFFORTS] : effortsFor(a.cfg.model);
      if (!levels.length) return void a.say(`${a.cfg.model} is not a reasoning model, so there is no effort setting`, yellow);
      let e: string | undefined = arg;
      if (!e) e = await a.pick("Reasoning effort", [{ label: "default", value: "default", hint: "let the model decide" }, ...levels.map((x) => ({ label: x, value: x as string, hint: x === "none" ? "no reasoning: fastest" : x === "max" ? "deepest" : undefined }))], a.cfg.effort ? Math.max(0, levels.indexOf(a.cfg.effort as never)) + 1 : 0);          // preselect what is set now, or "default"
      if (!e) return;
      if (e !== "default" && !levels.includes(e as never)) return void a.say(`"${e}" is not valid for ${a.cfg.model}. Choose: ${levels.join(", ")}`, red);
      a.cfg.effort = e === "default" ? undefined : (e as typeof a.cfg.effort); a.saveConfig(); a.buildAgent(); a.say(`effort → ${cyan(e)}`, dim);
    } },
    { name: "api", help: "OpenAI wire API: auto · responses · chat", args: "[mode]", run: async (a, arg) => {
      if (a.cfg.provider === "anthropic") return void a.say("this applies to OpenAI-compatible providers only", yellow);
      const m = arg || (await a.pick("OpenAI wire API", [{ label: "auto", value: "auto", hint: "Responses for reasoning models, Chat elsewhere; self-correcting (default)" }, { label: "responses", value: "responses", hint: "/v1/responses: required for tools + reasoning on current models" }, { label: "chat", value: "chat", hint: "/v1/chat/completions: Ollama, vLLM, most gateways" }]));
      if (!m) return;
      if (!["auto", "responses", "chat"].includes(m)) return void a.say(`unknown mode "${m}"`, red);
      a.cfg.api = m as "auto"; a.saveConfig(); a.buildAgent(); a.say(`api → ${cyan(m)}`, dim);
    } },
    { name: "mode", help: "permissions: default · acceptEdits · plan · yolo", args: "[mode]", run: async (a, arg) => {
      const m = arg || (await a.pick("Permission mode", [
        { label: "default", value: "default", hint: "ask before edits and non-trivial commands" }, { label: "acceptEdits", value: "acceptEdits", hint: "edits are automatic, commands still ask" },
        { label: "plan", value: "plan", hint: "read-only: investigate and propose a plan" }, { label: "yolo", value: "yolo", hint: "never ask (dangerous)" }]));
      if (!m) return;
      if (!["default", "acceptEdits", "plan", "yolo"].includes(m)) return void a.say(`unknown mode "${m}"`, red);
      a.setMode(m as never);
    } },
    { name: "plan", help: "enter plan mode (read-only)", run: (a) => a.setMode("plan") },
    { name: "clear", help: "start a fresh conversation", alias: "new", run: (a) => {
      a.newConversation(); a.screen.height = 0; a.io.output.write("\x1b[2J\x1b[3J\x1b[H");
      a.commit([dim("  conversation cleared; the old one is saved (use /resume)"), ""]);
    } },
    { name: "compact", help: "summarise the conversation to free up context", run: async (a) => {
      if (!a.session.messages.length) return void a.say("nothing to compact yet", dim);
      a.note("compacting…", 60_000);
      const r = await a.agent.compact(a.session.messages);
      a.session.messages = r.messages; a.lastPrompt = 0; a.saveSession(); a.noticeUntil = 0; a.rebuildBlocks();
      a.commit(["", `  ${green("✓")} ${dim("conversation compacted into a handoff note")}`, ...r.note.split("\n").slice(0, 8).map((l) => "    " + dim(l))]);
    } },
    { name: "memory", help: "list notes · forget <name> · add <text> · stale · prune · consolidate · graph · embeddings", args: "[forget|add|stale|prune|consolidate|graph|embeddings]", run: async (a, arg) => {
      const m = a.memory; if (!m) return void a.say("memory is disabled", yellow);
      const [sub, ...rest] = arg.split(/\s+/), tail = rest.join(" ");
      if (sub === "forget" && tail) return void a.say(m.forget(tail) ? `forgot ${tail}` : `no note named ${tail}`, dim);
      if (sub === "add" && tail) return a.remember(tail);
      if (sub === "embeddings") {
        if (tail !== "on" && tail !== "off") return void a.say(`semantic memory search is ${a.cfg.embeddings ? "on" : "off"}. /memory embeddings on|off`, dim);
        if (tail === "on" && a.cfg.provider === "anthropic") return void a.say("Claude has no embeddings endpoint. Switch the provider to an OpenAI-compatible one (/provider), or keep keyword search.", yellow);
        a.cfg.embeddings = tail === "on"; a.saveConfig(); a.buildAgent();
        return void a.say(tail === "on" ? "semantic memory search on: note text and your messages are sent to your provider's /embeddings endpoint (stored vectors live in memory/embeddings.json)" : "semantic memory search off", dim);
      }
      if (sub === "graph") { const all = m.list(), rows = all.map((e) => [e, m.neighbors(e, all)] as const).filter(([, n]) => n.length); return void a.commit(rows.length ? ["", bold("  Related notes"), ...rows.map(([e, n]) => `  ${cyan(e.name.padEnd(24))} ${dim("↔")} ${n.map((x) => x.name).join(", ")}`), dim("  links come from [[name]] mentions and from notes that keep being retrieved together")] : ["", dim("  no links yet. Mention [[other-note]] in a note, or keep using memory: notes retrieved together get linked.")]); }
      if (sub === "consolidate") {
        a.say("asking the model to tidy memory (merge duplicates, archive obsolete notes)…", dim);
        const plan = await m.consolidate(a.roles.compact ?? a.model);
        if (!plan.merges.length && !plan.archive.length) return void a.say("memory looks tidy: nothing to merge or archive", dim);
        const lines = [...plan.merges.map((x) => `merge ${x.from.join(", ")} → ${x.keep}`), ...plan.archive.map((n) => `archive ${n}`)];
        a.commit(["", bold("  Proposed memory clean-up"), ...lines.map((l) => "  " + l), dim("  nothing is deleted: replaced notes move to memory/archive/")]);
        const ok = await a.pick("Apply this clean-up?", [{ label: "Yes, apply", value: "y" }, { label: "No", value: "n" }]);
        if (ok === "y") { const r = m.applyPlan(plan); a.say(`merged ${r.merged}, archived ${r.archived}`, dim); }
        return;
      }
      if (sub === "stale") { const st = m.stale(); return void a.commit(st.length ? ["", bold("  Never-used notes (older than 90 days, surfaced at most once)"), ...st.map((e) => `  ${cyan(e.name.padEnd(24))} ${dim(`[${e.scope}/${e.type}] last used ${e.used ?? e.updated}`)}`), dim("  /memory prune moves them to an archive folder (reversible)")] : ["", dim("  no stale notes")]); }
      if (sub === "prune") { const gone = m.prune(); return void a.say(gone.length ? `archived ${gone.length} stale note${gone.length === 1 ? "" : "s"}: ${gone.join(", ")} (moved to memory/archive/)` : "nothing stale to archive", dim); }
      const all = m.list();
      if (!all.length) return void a.say("no memory notes yet. Use `# note` or ask me to remember something.", dim);
      a.commit(["", bold("  Memory"), ...all.map((e) => `  ${cyan(e.name.padEnd(24))} ${dim(`[${e.scope}/${e.type}]${e.hits ? ` · used ${e.hits}×` : ""}`)} ${e.description}`)]);
    } },
    { name: "resume", help: "continue an earlier conversation", alias: "sessions", run: async (a) => {
      const list = a.store.list().filter((s) => s.id !== a.session.id);
      if (!list.length) return void a.say("no earlier conversations in this project", dim);
      const id = await a.pick("Resume", list.map((s) => ({ label: s.title || "(untitled)", value: s.id, hint: `${s.turns} turns · ${s.updated.slice(0, 16).replace("T", " ")} · ${s.model}` })));
      const s = id && a.store.load(id); if (!s) return;
      a.loadSession(s); a.rebuildBlocks(); a.commit(["", `  ${green("↻")} ${dim(`resumed "${s.title}" (${s.turns.length} turns)`)}`]);
    } },
    { name: "export", help: "save a portable session bundle", args: "[file]", run: async (a, arg) => {
      if (!a.session.turns.length) return void a.say("nothing to export yet", dim);
      a.note("writing handoff…", 60_000);
      const file = resolve(a.cwd, arg || join(".amness", "sessions", `${a.session.id}.json`));
      const touched = new Set(a.edits.map((e) => e.path));
      const { bundle } = await a.agent.exportBundle({ messages: a.session.messages, finished: true, text: a.session.title }, undefined);
      bundle.files = collectFiles(a.cwd, touched);
      writeBundle(file, bundle); a.noticeUntil = 0;
      a.say(`${green("✓")} ${file}\n${dim(`${Object.keys(bundle.files).length} file(s), ${bundle.memory.length} note(s). Continue anywhere: amness run --bundle <file> "continue"  or  /import <file>`)}`);
    } },
    { name: "import", help: "continue from a session bundle", args: "<file>", run: async (a, arg) => {
      if (!arg) return void a.say("usage: /import <bundle.json>", yellow);
      const b: Bundle = readBundle(resolve(a.cwd, arg));
      a.newConversation();
      await a.turn(`Continue the work from a previous session.\n\nOriginal task: ${b.task}\nStatus then: ${b.status.finished ? "finished" : "unfinished"}\n\n${b.handoff}\n\nRe-check the workspace before continuing.`);
    } },
    { name: "diff", help: "review every change from this session", live: true, run: async (a) => {
      if (!a.edits.length) return void a.say("no edits in this session yet", dim);
      a.openPager(a.edits.flatMap((e) => ["", bold(`${e.path}${e.created ? " (new)" : ""}  ${green("+" + e.added)} ${red("-" + e.removed)}`), ...renderDiff(e.diff, a.screen.cols - 1, 400)]), "changes");
    } },
    { name: "undo", help: "revert the last turn (files and conversation)", run: (a) => {
      if (!a.session.turns.length) return void a.say("nothing to undo", dim);
      a.rewindTo(a.session.turns.length - 1);
    } },
    { name: "rewind", help: "go back to an earlier turn", run: (a) => a.openRewind() },
    { name: "loop", alias: "trace", help: "step-by-step trace of the agent loop: model turns, tools, guards", live: true, run: (a) => {
      const T = a.trace; if (!T.length) return a.say(dim("no loop activity yet: send a task first"));
      const tot = T.reduce((n, s) => n + s.completion + s.prompt, 0), ms = T.reduce((n, s) => n + s.ms, 0);
      const waste = cacheWaste(a.tracer?.turns ?? []), wasteCost = waste ? estimateCost(a.cfg.model, waste, 0) : null, wasteNote = waste > 500 ? `${fmtTokens(waste)} tokens re-read at full price after cache breaks${wasteCost !== null ? ` (≈ ${fmtCost(wasteCost - estimateCost(a.cfg.model, waste, 0, waste)!)} wasted)` : ""} · ` : "";
      const out = ["", bold(`Agent loop · ${T.length} turn${T.length === 1 ? "" : "s"} · ${fmtDuration(ms)} · ${fmtTokens(tot)} tokens`), dim(`${wasteNote}${a.trimmed ? `trimmed ~${fmtTokens(Math.round(a.trimmed / 4))} tokens of stale or noisy output · ` : ""}${a.cacheBreaks ? `${a.cacheBreaks} cache break${a.cacheBreaks === 1 ? "" : "s"} · ` : ""}each turn: the model answers, its tool calls run, results go back; guards are shown where they fired`), ""];
      for (const s of T) {
        const pad = String(s.n).padStart(2);
        out.push(`${cyan(`${pad} ●`)} ${bold("model")} ${dim(`${fmtDuration(s.ms)} · ${fmtTokens(s.prompt)} in · ${fmtTokens(s.completion)} out${s.cached ? ` · ${fmtTokens(s.cached)} cached` : ""}`)}`);
        s.tools.forEach((x, i) => out.push(`     ${dim(i === s.tools.length - 1 && !s.notes.length ? "└─" : "├─")} ${x.ok ? green("✓") : red("✗")} ${toolCall(x.name, x.args)} ${dim(fmtDuration(x.ms))}${s.parallel && s.parallel > 1 && i === 0 ? dim(`  (${s.parallel} calls this turn)`) : ""}`));
        s.notes.forEach((n, i) => out.push(`     ${dim(i === s.notes.length - 1 ? "└─" : "├─")} ${yellow("⚑")} ${dim(n)}`));
        if (!s.tools.length && !s.notes.length) out.push(`     ${dim("└─ replied without tools")}`);
      }
      return a.openPager(out, "loop trace");
    } },
    { name: "tokens", alias: "cost", help: "context window, what fills it, tokens and cost", live: true, run: (a) => {
      a.commit(tokenReport({ model: a.cfg.model, messages: a.session.messages, usage: a.session.usage, series: a.session.usage.series ?? [], lastPrompt: a.lastPrompt, turnTokens: a.runTokens, turnBudget: a.running ? a.cfg.maxTokens : 0, width: a.width,
        toolDefChars: JSON.stringify(a.agent.registry.visible({ step: 0, messages: [] }).map((t) => ({ name: t.name, description: t.description, parameters: t.schema }))).length }));
    } },
    { name: "todos", help: "show the agent's checklist", live: true, run: (a) => a.commit(["", ...(a.todos.length ? todoList(a.todos, a.width) : [dim("  no todo list right now")])]) },
    { name: "copy", help: "copy the last reply to the clipboard (or: code, all)", args: "[code|all]", live: true, run: (a, arg) => {
      const bs = a.blocks.blocks, last = [...bs].reverse().find((b) => b.kind === "assistant" || b.kind === "summary");
      let text = "";
      if (arg === "all") text = bs.flatMap((b) => b.kind === "user" ? ["> " + b.text, ""] : b.kind === "assistant" || b.kind === "summary" ? [b.text, ""] : b.kind === "tool" ? [`[${b.name} ${b.args.slice(0, 120)}]`] : []).join("\n").trim();
      else if (arg === "code") { const cb = last && "text" in last ? codeBlocks(last.text) : []; text = cb[cb.length - 1] ?? ""; if (!text) return void a.say("no code block in the last reply", dim); }
      else text = last && "text" in last ? last.text : "";
      if (!text) return void a.say("nothing to copy yet", dim);
      a.copyText(text); a.say(`copied ${text.length} characters to the clipboard`, dim);
    } },
    { name: "keepwarm", help: "keep the Claude prompt cache alive while you are away (costs a few cache reads)", args: "[on|off]", run: (a, arg) => {
      if (!arg) return void a.say(`keep-warm is ${a.cfg.keepWarm ? "on" : "off"}. Claude drops its prompt cache after 5 idle minutes; with this on, a tiny re-send every ~4.5 minutes (at most 3 per break) keeps it. Only affects Claude.`, dim);
      a.cfg.keepWarm = arg === "on"; a.saveConfig(); if (!a.cfg.keepWarm) a.stopWarm(); a.say(`keep-warm ${a.cfg.keepWarm ? "on" : "off"}${a.cfg.keepWarm && a.cfg.provider !== "anthropic" ? dim("  (only Claude needs it; OpenAI requests already ask for 24h cache retention)") : ""}`, dim);
    } },
    { name: "procs", help: "background processes the agent started (stop one with /procs stop <id>)", args: "[stop <id>]", live: true, run: async (a, arg) => {
      const [sub, id] = arg.split(/\s+/);
      if (sub === "stop" && id) { try { const p = await a.agent.procs!.stop(id); return void a.say(`stopped ${p.id} (${p.name})`, dim); } catch (e) { return void a.say((e as Error).message, red); } }
      const l = a.agent.procs?.list() ?? [];
      a.commit(["", bold("  Background processes"), ...(l.length ? l.map((p) => `  ${(p.status === "running" ? green : dim)(p.id.padEnd(4))} ${p.name.padEnd(28)} ${dim(`${p.status}${p.status === "exited" ? ` (${p.code})` : ""} · pid ${p.pid ?? "?"} · ${Math.round((Date.now() - p.startedAt) / 1000)}s`)}`) : [dim("  none")])]);
    } },
    { name: "hooks", help: "lifecycle hooks in effect (.amness/hooks.json, ~/.amness/hooks.json)", live: true, run: (a) => {
      const l = a.hooks.list(), fp = Hooks.fingerprint(a.cwd);
      a.commit(["", bold("  Hooks"), ...(l.length ? l.map((h) => `  ${cyan(h.event.padEnd(16))} ${h.def.match ? dim(`[${h.def.match}] `) : ""}${h.def.command} ${dim(`${h.def.timeout ?? 10}s${h.def.failClosed ? " · fail closed" : ""}`)}`) : [dim("  none active")]), ...(fp && !l.some(() => true) ? [dim("  this project has .amness/hooks.json but it is not approved; restart and allow it")] : []), dim("  exit 0 allows · exit 2 blocks (stderr is shown to the model) · stdout JSON can add context or rewrite arguments")]);
    } },
    { name: "permissions", help: "permission rules: list · allow|ask|deny <rule> · e.g. /permissions allow sh(npm test*)", args: "[allow|ask|deny <rule>]", live: true, run: (a, arg) => {
      const [list, ...rest] = arg.split(/\s+/), rule = rest.join(" ");
      if (list === "allow" || list === "ask" || list === "deny") {
        if (!rule) return void a.say(`usage: /permissions ${list} sh(npm test*)  ·  edit(src/**)  ·  read`, dim);
        try { Permissions.addProjectRule(a.cwd, list, rule); } catch (e) { return void a.say((e as Error).message, red); }
        const fp = projectConfigFingerprint(a.cwd), st = loadState(); if (fp && st.hookTrust?.[a.cwd]) { st.hookTrust[a.cwd] = fp; saveState(st); }     // you wrote it, so it stays trusted
        a.loadHooks(); a.buildAgent(); return void a.say(`${list} ${rule} saved to .amness/permissions.json`, dim);
      }
      const r = a.rules.rules();
      a.commit(["", bold("  Permission rules"), ...(["deny", "ask", "allow"] as const).flatMap((k) => r[k].map((x) => `  ${(k === "deny" ? red : k === "ask" ? yellow : green)(k.padEnd(6))} ${x}`)), ...(!r.deny.length && !r.ask.length && !r.allow.length ? [dim("  no rules yet")] : []),
        "", dim("  always on, in every mode including yolo: no recursive delete of / or ~, no force-push to main, no editing .git or these rule files; curl|sh and force-pushes always ask"), dim("  precedence: that floor > deny > ask > allow > permission mode")]);
    } },
    { name: "reviewer", help: "independent skeptical reviewer: criteria before the work, a check before it is accepted (costs extra model calls)", args: "[on|off]", run: (a, arg) => {
      if (!arg) return void a.say(`reviewer is ${a.cfg.review ? "on" : "off"}. /reviewer on: a fresh, read-only reviewer writes acceptance criteria before a task and checks the work against them before it can finish (at most two rounds). Roughly +2 to +4 model calls per task.`, dim);
      a.cfg.review = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`reviewer ${arg === "on" ? "on" : "off"}`, dim);
    } },
    { name: "review", help: "a read-only review of your changes (vs the base branch, or /review <base>)", args: "[base]", run: async (a, arg) => {
      let r; try { r = await diffForReview(a.cwd, arg || undefined); } catch (e) { return void a.say(`not a git repository, or git failed: ${(e as Error).message}`, red); }
      if (!r.diff.trim()) return void a.say(`no changes against ${r.against} to review`, dim);
      a.say(`reviewing ${r.diff.split("\n").filter((l) => l.startsWith("diff --git")).length} changed file(s) against ${r.against}…`, dim);
      const v = await reviewWork({ model: a.roles.review ?? a.model, cwd: a.cwd, task: "Review these changes as a careful colleague would before they are merged.", contract: ["the change does what its code and commit messages suggest, without introducing bugs", "edge cases and error paths are handled", "nothing unrelated or leftover (debug code, secrets, commented-out code) is included", "behaviour that changed is covered by tests, or the missing tests are named"], summary: "(a human asked for a review; there is no author summary)", diffs: r.diff.slice(0, 60_000), commands: "", verify: a.verify, budget: a.budget });
      a.commit(["", v.inconclusive ? `  ${yellow("?")} ${dim("the reviewer gave no usable verdict; try again, or use /reviewer on for tasks")}` : v.pass ? `  ${green("✔")} ${bold("review: no problems found")}` : `  ${yellow("✖")} ${bold(`review: ${v.findings.length} finding${v.findings.length === 1 ? "" : "s"}`)}`, ...v.findings.map((f) => `    ${yellow("•")} ${f}`)]);
    } },
    { name: "pr", help: "draft a pull request from your branch and create it with gh after you confirm (/pr draft for a draft PR)", args: "[draft]", run: async (a, arg) => {
      const have = await new Promise<boolean>((res) => execFile("gh", ["--version"], (e) => res(!e)));
      if (!have) return void a.say("the GitHub CLI (gh) is needed to create pull requests: https://cli.github.com", yellow);
      const branch = await currentBranch(a.cwd), base = await defaultBase(a.cwd);
      if (!base) return void a.say("could not find a base branch (no origin/HEAD, main or master)", red);
      if (branch === base.replace(/^origin\//, "") || branch === "HEAD") return void a.say(`you are on ${branch}; make a branch for your changes first`, yellow);
      const { diff } = await diffForReview(a.cwd, base), log = await commitLog(a.cwd, base);
      if (!diff.trim() && !log) return void a.say(`nothing to open a pull request for against ${base}`, dim);
      a.say("drafting the pull request…", dim);
      let d; try { d = await draftPr(a.roles.compact ?? a.model, { diff, log, branch }); } catch (e) { return void a.say((e as Error).message, red); }
      a.commit(["", bold(`  ${d.title}`), dim(`  ${branch} → ${base.replace(/^origin\//, "")}`), "", ...d.body.split("\n").map((l) => "  " + l)]);
      const choice = await a.pick("Create this pull request on GitHub?", [{ label: "Create it", value: "pr" }, { label: "Create it as a draft", value: "draft" }, { label: "Cancel", value: "no" }]);
      if (!choice || choice === "no") return void a.say("not created", dim);
      if (!(await hasUpstream(a.cwd))) { const push = await a.pick("The branch is not on the remote yet. Push it now (git push -u origin HEAD)?", [{ label: "Yes, push it", value: "y" }, { label: "No", value: "n" }]); if (push !== "y") return void a.say("not created: push the branch first", dim); try { await pushBranch(a.cwd); } catch (e) { return void a.say(`push failed: ${(e as Error).message}`, red); } }
      try { const url = await createPr(a.cwd, d, { base, draft: choice === "draft" || arg === "draft" }); a.say(`created: ${url}`, green); } catch (e) { a.say(`gh failed: ${(e as Error).message}`, red); }
    } },
    { name: "report", help: "recurring problems in your session traces · /report case <name> turns the last request into an eval task", args: "[case <name>]", run: async (a, arg) => {
      const [sub, name] = arg.split(/\s+/);
      if (sub === "case") {
        if (!name) return void a.say("usage: /report case <name>   (then it asks for the command that proves the task is solved)", dim);
        const prompts = a.blocks.prompts(), last = prompts.at(-1)?.block; if (!last || last.kind !== "user") return void a.say("send a task first: the case is built from your last request", dim);
        const check = await a.askText(`A command that exits 0 only when "${last.text.slice(0, 50).replace(/\s+/g, " ")}" is really done (the agent never sees it)`); if (!check) return void a.say("cancelled", dim);
        const r = caseFromWorkspace(a.cwd, { name, task: last.text, check, verify: a.verify }); return void a.say(`wrote ${r.path.replace(a.cwd + "/", "")} (${r.files} files from git HEAD). Run: amness eval --cases .amness/evals/cases --variants ab`, dim);
      }
      a.commit(["", ...formatMining(join(a.cwd, ".amness", "traces")).split("\n").map((l) => "  " + l)]);
    } },
    { name: "models", help: "use other models for some jobs: /models explore|compact|review <model|off> · /models fallback <model|off>", args: "[role model]", run: (a, arg) => {
      const [role, id] = arg.split(/\s+/), roles = ["explore", "compact", "review", "cheap"];
      if (!role) { const m = a.cfg.models ?? {}; return void a.commit(["", bold("  Models"), `  ${dim("main".padEnd(10))} ${a.cfg.model}`, ...roles.map((r) => `  ${dim(r.padEnd(10))} ${(m as Record<string, string | undefined>)[r] ?? dim("(main model)")}`), `  ${dim("fallback".padEnd(10))} ${a.cfg.fallback ?? dim("(none)")}`, dim("  e.g. /models explore gpt-6.1-luna   (a cheaper model for read-only exploration)")]); }
      if (role !== "fallback" && !roles.includes(role)) return void a.say("usage: /models explore|compact|review|cheap|fallback <model id | off>", red);
      if (!id) return void a.say(`usage: /models ${role} <model id | off>`, red);
      if (role === "fallback") a.cfg.fallback = id === "off" ? undefined : id; else a.cfg.models = { ...(a.cfg.models ?? {}), [role]: id === "off" ? undefined : id };
      a.saveConfig(); a.buildAgent(); a.say(`${role} → ${id === "off" ? "main model" : id}`, dim);
    } },
    { name: "policy", help: "why recent actions were allowed, asked about or refused (rules, the safety floor, untrusted-text checks)", live: true, run: (a) => {
      a.commit(["", bold("  Recent policy decisions"), ...(a.policyLog.length ? a.policyLog.map((l) => "  " + (l.startsWith("deny") ? red(l.slice(0, 5)) : l.startsWith("ask") ? yellow(l.slice(0, 5)) : green(l.slice(0, 5))) + l.slice(5)) : [dim("  none yet: every call so far went through the permission mode alone")]),
        "", dim("  layers: safety floor > deny rules > untrusted-text check (commands copied from web pages or tool servers) > ask rules > allow rules > permission mode"), dim("  /permissions lists your rules, /sandbox shows OS enforcement")]);
    } },
    { name: "profile", help: "harness settings for this model (.amness/profile.json): guards switched off, limits", live: true, run: (a) => {
      const p = a.profile.profile;
      a.commit(["", bold("  Harness profile"), `  ${dim("model")}   ${a.cfg.model}`, `  ${dim("from")}    ${a.profile.sources.length ? a.profile.sources.map((s) => s.replace(a.cwd + "/", "")).join(", ") : dim("(none: built-in defaults)")}`, `  ${dim("off")}     ${p.off?.length ? p.off.join(", ") : dim("nothing: every guard is on")}`, `  ${dim("limits")}  ${[p.maxSteps !== undefined && `max steps ${p.maxSteps}`, p.stagnationTurns !== undefined && `stagnation after ${p.stagnationTurns} turns`].filter(Boolean).join(" · ") || dim("defaults")}`, ...(p.note ? [`  ${dim("note")}    ${p.note}`] : []), dim("  write one from measurements: amness eval --variants ablate --profile-out profile.json")]);
    } },
    { name: "router", help: "route exploration steps to a cheaper model when that pays off, cache cost included (needs /models cheap <id>)", args: "[on|off]", run: (a, arg) => {
      if (!arg) return void a.say(`router is ${a.cfg.router ? "on" : "off"}${a.cfg.models?.cheap ? ` (cheap model: ${a.cfg.models.cheap})` : dim("  (set one with /models cheap <model id>)")}. Planning, edits, failures and answers always use ${a.cfg.model}; a run of read-only steps moves to the cheap model once the saving repays the cold read of the conversation on that model's own cache.`, dim);
      if (arg === "on" && !a.cfg.models?.cheap) return void a.say("choose the cheap model first: /models cheap <model id>", red);
      a.cfg.router = arg === "on"; a.saveConfig(); a.buildAgent(); a.say(`router ${arg === "on" ? "on" : "off"}`, dim);
    } },
    { name: "sandbox", help: "OS sandbox for shell commands: off · workspace · strict (no network)", args: "[off|workspace|strict]", run: (a, arg) => {
      const kind = sandboxKind();
      if (!arg) return void a.say(`sandbox: ${a.cfg.sandbox ?? "off"}${kind ? dim(` (${kind === "seatbelt" ? "macOS Seatbelt" : "Bubblewrap"} available)`) : dim(` (not available here: ${sandboxHelp()})`)}.  workspace: commands can write only in the project and temp/cache folders, .git stays read-only. strict: also no network.`, dim);
      if (!SANDBOX_MODES.includes(arg as SandboxMode)) return void a.say("usage: /sandbox off | workspace | strict", red);
      if (arg !== "off" && !kind) return void a.say(`cannot turn the sandbox on: ${sandboxHelp()}`, red);
      a.cfg.sandbox = arg as SandboxMode; a.saveConfig(); a.say(`sandbox ${arg}${arg === "strict" ? dim("  (commands that need the network, like npm install, will fail)") : ""}`, dim);
    } },
    { name: "agents", help: "custom subagents (.amness/agents/*.md, .claude/agents/*.md) available to the task tool", live: true, run: (a) => {
      const l = a.agent.agents ?? [], w = a.agent.agentWarnings ?? [];
      a.commit(["", bold("  Subagents"), `  ${cyan("explore".padEnd(16))} ${dim("[built in · read-only]")} broad searches and questions that need reading many files`, ...l.map((s) => `  ${cyan(s.name.padEnd(16))} ${dim(`[${s.scope} · ${s.tools.join(", ")}${s.isolation ? " · isolated worktree" : ""}${s.model ? " · model " + s.model : ""}]`)} ${s.description}`), ...(!l.length ? [dim("  add .amness/agents/<name>.md (front matter: name, description, tools, model, isolation) to define your own")] : []), ...w.map((x) => "  " + yellow("⚠ ") + dim(x))]);
    } },
    { name: "skills", help: "skills found (SKILL.md folders in .amness/.agents/.claude skills, project and home)", live: true, run: (a) => {
      const l = a.agent.skills ?? [], w = a.agent.skillWarnings ?? [];
      a.commit(["", bold("  Skills"), ...(l.length ? l.map((s) => `  ${cyan(s.name.padEnd(22))} ${dim(`[${s.scope} · ${s.source}]`)} ${s.description}`) : [dim("  none found. Add .amness/skills/<name>/SKILL.md with a name and description in its front matter.")]), ...w.map((x) => "  " + yellow("⚠ ") + dim(x))]);
    } },
    { name: "check", help: "fast command run after every edit (typecheck, lint); failures go straight back to the model", args: "[cmd|off]", run: (a, arg) => {
      if (!arg) return void a.say(a.check ? `post-edit check: ${cyan(a.check)}` : "no post-edit check set. /check npx tsc --noEmit", dim);
      a.setCheck(arg === "off" ? undefined : arg); a.say(arg === "off" ? "post-edit check off" : `post-edit check → ${cyan(arg)}`, dim);
    } },
    { name: "verify", help: "command that must pass before it may finish", args: "[cmd|off]", run: (a, arg) => {
      if (!arg) return void a.say(a.verify ? `verify: ${cyan(a.verify)}` : "no verify command set. /verify npm test", dim);
      a.setVerify(arg === "off" ? undefined : arg); a.say(arg === "off" ? "verify gate off" : `verify gate → ${cyan(arg)}`, dim);
    } },
    { name: "live", help: "open the browser live view (diffs stream there)", live: true, run: async (a) => {
      const l = await a.ensureLive(); a.say(`${cyan("●")} live view: ${bold(l.url)}`);
      const { execFile } = await import("node:child_process");
      execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [l.url], () => {});
    } },
    { name: "mcp", help: "attach an MCP server: /mcp <command…> · /mcp list · /mcp off", args: "<command>", run: async (a, arg) => {
      if (!arg || arg === "list") return void a.commit(["", ...(a.mcp.length ? a.mcp.map((m) => `  ${cyan("●")} ${m.cmd}  ${dim(m.tools.length + " tools")}`) : [dim("  no MCP servers attached. /mcp npx -y @modelcontextprotocol/server-filesystem .")])]);
      if (arg === "off") { a.mcp.splice(0).forEach((m) => m.close()); a.buildAgent(); return void a.say("MCP servers detached", dim); }
      const [command, ...rest] = arg.split(/\s+/);
      const prefix = (rest.find((x) => !x.startsWith("-")) ?? command).split("/").pop()!.replace(/\.\w+$/, "").replace(/[^\w]+/g, "_");
      a.note("connecting…", 60_000);
      const h = await loadMcp(command, rest, { prefix }); a.noticeUntil = 0;
      a.mcp.push({ cmd: arg, tools: h.tools, close: h.close }); a.agent.registry.add(...h.tools);
      a.say(`${green("✓")} ${arg}\n${dim(h.tools.length + " tools: " + h.tools.slice(0, 6).map((t) => t.name).join(", ") + (h.tools.length > 6 ? "…" : "") + ". Tools that change things will ask first.")}`);
    } },
    { name: "init", help: "have the agent write AGENTS.md for this repo", run: (a) => a.turn(INIT_PROMPT) },
    { name: "tools", help: "list the tools the agent can use right now", live: true, run: (a) => {
      const vis = a.agent.registry.visible({ step: 0, messages: [] });
      a.commit(["", bold("  Tools"), ...vis.map((t) => `  ${cyan(t.name.padEnd(16))} ${dim(t.description.split(".")[0].slice(0, a.width - 22))}`)]);
    } },
    { name: "status", help: "model, mode, project, session", live: true, run: (a) => {
      a.commit(["", bold("  Status"), `  ${dim("model")}     ${a.cfg.model} ${dim("via " + a.providerInfo().label + (a.model.api ? ` · ${a.model.api()} API` : ""))}`, ...(a.cfg.effort ? [`  ${dim("effort")}    ${a.cfg.effort}`] : []), `  ${dim("mode")}      ${a.mode}`, `  ${dim("project")}   ${a.cwd}${a.branch ? dim("  ⎇ " + a.branch) : ""}`,
        `  ${dim("verify")}    ${a.verify ?? "none"}`, `  ${dim("session")}   ${a.session.id} ${dim(`(${a.session.turns.length} turns)`)}`, `  ${dim("memory")}    ${a.memory?.list().length ?? 0} notes`, `  ${dim("sandbox")}   ${a.cfg.sandbox ?? "off"}`, `  ${dim("trace")}     ${a.tracer?.file ? a.tracer.file.replace(a.cwd + "/", "") : "(after the first message)"}`, `  ${dim("instructions")} ${a.agent.guidance?.files.join(", ") || "none loaded (add an AGENTS.md)"}`, `  ${dim("running")}   ${a.running ? "yes, " + fmtDuration(Date.now() - a.runStart) : "no"}`]);
    } },
    { name: "theme", help: "colour theme (live preview)", args: "[name]", run: async (a, arg) => {
      const prev = a.cfg.theme;
      const choose = (n: string | undefined) => { a.cfg.theme = n ?? prev; a.full?.invalidate(); a.render(); };
      let name: string | undefined = arg;
      if (!name) {
        name = await a.pick("Theme", themeNames().map((n) => ({ label: THEMES[n].label, value: n, hint: THEMES[n].dark ? "dark" : "light" })), Math.max(0, themeNames().indexOf(getTheme(prev).name)), (v) => choose(v));
        if (!name) { choose(prev); return; }
      }
      if (!THEMES[name]) { choose(prev); return void a.say(`unknown theme "${name}". Try: ${themeNames().join(", ")}`, red); }
      choose(name); a.saveConfig(); a.say(`theme → ${cyan(THEMES[name].label)}${a.full ? "" : dim("  (themes apply to the full-screen UI; try /ui full)")}`, dim);
    } },
    { name: "sidebar", help: "show or hide the side panel", alias: "side", live: true, run: (a) => { if (!a.full) return void a.say("the side panel is part of the full-screen UI (/ui full)", dim); a.full.showSidebar = !a.full.showSidebar; a.full.invalidate(); } },
    { name: "details", help: "expand or collapse all tool output", live: true, run: (a) => { if (!a.full) return void a.say("full-screen UI only (/ui full)", dim); a.full.expandAll = !a.full.expandAll; a.full.toast(a.full.expandAll ? "all tool output expanded" : "tool output collapsed"); } },
    { name: "diffmode", help: "diff layout: auto · stacked · split", args: "[mode]", live: true, run: (a, arg) => {
      if (!a.full) return void a.say("full-screen UI only (/ui full)", dim);
      if (!["auto", "stacked", "split"].includes(arg)) return void a.say(`diff layout is ${cyan(a.full.diffMode)}. Choose: auto, stacked, split`, dim);
      a.full.diffMode = arg as "auto"; a.full.invalidate(); a.say(`diff layout → ${cyan(arg)}`, dim);
    } },
    { name: "mouse", help: "mouse on/off (off restores native text selection)", args: "[on|off]", live: true, run: (a, arg) => { if (!a.full) return void a.say("full-screen UI only (/ui full)", dim); a.full.setMouse(arg ? arg !== "off" : !a.full.mouseOn); } },
    { name: "ui", help: "switch between the full-screen and inline UI", args: "[full|inline]", run: (a, arg) => {
      const to = arg === "full" || arg === "inline" ? arg : a.ui === "full" ? "inline" : "full";
      a.cfg.ui = to; a.saveConfig();
      if (to === a.ui) return void a.say(`already using the ${to} UI`, dim);
      a.switchUi(to);
    } },
    { name: "exit", alias: "quit", help: "leave", live: true, run: (a) => a.exit(0) },
  ];
}


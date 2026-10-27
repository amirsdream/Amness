// Slash commands. Each gets the running App and the raw argument string.
import { join, resolve } from "node:path";
import { collectFiles, effortsFor, loadMcp, readBundle, writeBundle, type Bundle } from "../../src/index.ts";
import { CLAUDE_MODELS, OPENAI_MODELS, PROVIDERS, type ProviderId } from "../config.ts";
import { bold, cyan, dim, green, red, yellow } from "../ui.ts";
import type { App } from "./app.ts";
import { estimateCost, fmtCost, fmtDuration, fmtTokens } from "./pricing.ts";
import { codeBlocks } from "./clipboard.ts";
import { Hooks, Permissions, cacheWaste, projectConfigFingerprint } from "../../src/index.ts";
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
        const plan = await m.consolidate(a.model);
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
        `  ${dim("verify")}    ${a.verify ?? "none"}`, `  ${dim("session")}   ${a.session.id} ${dim(`(${a.session.turns.length} turns)`)}`, `  ${dim("memory")}    ${a.memory?.list().length ?? 0} notes`, `  ${dim("trace")}     ${a.tracer?.file ? a.tracer.file.replace(a.cwd + "/", "") : "(after the first message)"}`, `  ${dim("instructions")} ${a.agent.guidance?.files.join(", ") || "none loaded (add an AGENTS.md)"}`, `  ${dim("running")}   ${a.running ? "yes, " + fmtDuration(Date.now() - a.runStart) : "no"}`]);
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


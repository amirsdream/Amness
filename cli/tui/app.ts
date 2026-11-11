// The chat TUI: one persistent conversation with a live input box, streaming output, permission prompts and slash commands.
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { onRateLimitWait } from "../model.ts";
import { applySandboxEngine, sandboxBackends, type CommandRisk, explainCommand, type OutsideRequest, STRATEGIES, setShell, shellFallbackNote, describeProjectPlugins, promptPlugin, loadPlugins, pluginFingerprint, runShell, type Plugin, type PluginCtx } from "../../src/index.ts";
import { quarantineReader, visionLikely, Budget, MemoryStore, Snapshots, Tracer, irreversibleReason, loadProfile, type Profile, sandboxKind, type Roles, createCodeAgent, Hooks, Permissions, projectConfigFingerprint, openaiEmbedder, riskOf, startLive, type Approve, type Event, type Guard, type Message, type Model, type PermMode, type Tool } from "../../src/index.ts";
import { detectWindow } from "../models.ts";
import { PROVIDERS, home, keyFor, keyIdOf, rememberWindow, saveConfig, storeKey, windowFor, type Config } from "../config.ts";
import { noStore, where } from "../keystore.ts";
import { editExternally, editorCommand, readClipboardImage, savePastedImage } from "./external.ts";
import { fileOpenCommand } from "./find.ts";
import { FOCUS_OFF, FOCUS_ON, notify } from "./notify.ts";
import { Vim } from "./vim.ts";
import { harnessView } from "./harnessinfo.ts";
import { detectVerify } from "../detect.ts";
import { createHash } from "node:crypto";
import { createModel } from "../model.ts";
import { wireModels, type Wired } from "../roles.ts";
import { loadState, saveState } from "../state.ts";
import { bold, cyan, dim, gray, green, magenta, red, yellow } from "../ui.ts";
import { BlockStore } from "./blocks.ts";
import { buildCommands, type Cmd } from "./commands.ts";
import { FullView } from "./full.ts";
import { loadCustomCommands } from "./custom.ts";
import { argOptions } from "./argcomplete.ts";
import { FileIndex, fuzzyScore, applySuggestion, menuRows, rankCommands, rankFiles, tokenAtCursor, type Suggestion, type Token } from "./complete.ts";
import { Editor } from "./editor.ts";
import { KeyParser, PASTE_OFF, PASTE_ON, type Key } from "./keys.ts";
import { renderMarkdown, takeCompleteBlocks } from "./markdown.ts";
import { expandMentions, attachedNote } from "./mentions.ts";
import { copyToClipboard } from "./clipboard.ts";
import { LongTextOverlay, ChoiceOverlay, InputOverlay, PickerOverlay, TextOverlay, editKey, type ChoiceDetail, type Overlay, type PickItem } from "./overlays.ts";
import { Pager, transcriptLines } from "./pager.ts";
import { TIPS, at, brandOf, fg, palette, shimmer, sparkline } from "./theme.ts";
import { contextWindow, estimateCost, fmtCost, fmtDuration, fmtTokens, priceOf } from "./pricing.ts";
import { Screen, type Out } from "./screen.ts";
import { SessionStore, forkSession, newSession, rewindFull, snapshot, type SessionData, type Turn } from "./session.ts";
import { basename } from "node:path";
import { cellWidth, clipWidth, wrapAnsi } from "./text.ts";
import { assistantBlock, editSummary, footer, helpLines, isFailure, renderDiff, todoList, toolCall, toolHeader, toolResult, userMessage, welcome } from "./view.ts";

type Ev = Event & { agent?: string };
type EditEv = Extract<Event, { kind: "edit" }>;
export type AppOptions = {
  cfg: Config; cwd: string; version: string;
  input?: any; output?: Out & { on?: (e: string, f: () => void) => void };
  makeModel?: (cfg: Config) => Model;
  resume?: "last" | string; prompt?: string; persist?: boolean; /** idle ms before a cache keep-alive ping (default 270000) */ keepWarmMs?: number;
  /** "full" = the full-screen UI (alternate screen, mouse, sidebar); "inline" = the classic scrollback UI; "remote" = no terminal: another front end (the desktop app) shows the same App through `remote`. */
  ui?: "full" | "inline" | "remote";
  /** For ui "remote": how the App tells its front end that something changed. Dialogs are the App's own overlays (`app.overlay`), which the front end shows and answers. */
  remote?: RemoteHooks;
};
/** A front end that is not a terminal. `changed` is called wherever the terminal UI would redraw; the front end reads the App's state then (throttled on its side). */
export type RemoteHooks = { changed(): void; toast(level: "info" | "ok" | "warn" | "error", text: string): void; copy?(text: string): void };
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];            // the status line "breathes"
const MODES: PermMode[] = ["default", "acceptEdits", "plan"];
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note";
const one = (s: string, n: number) => { const l = s.replace(/\s+/g, " ").trim(); return cellWidth(l) > n ? clipWidth(l, n - 1) + "…" : l; };

export type TraceStep = { n: number; t0: number; ms: number; prompt: number; completion: number; cached?: number; parallel?: number; tools: { name: string; args: string; ms: number; ok: boolean }[]; notes: string[] };
/** The exit code when the user does not trust the folder (the desktop app then goes back to the previous project). */
export const NOT_TRUSTED = 3;

export class App {
  cfg: Config; cwd: string; version: string; persist: boolean;
  io: { input: any; output: Out & { on?: (e: string, f: () => void) => void } };
  screen: Screen; keys = new KeyParser(); editor = new Editor(); files: FileIndex;
  mode: PermMode = "default";
  shRules = new Set<string>(); toolRules = new Set<string>();
  model!: Model; agent!: ReturnType<typeof createCodeAgent>; budget = new Budget();
  store: SessionStore; session: SessionData; edits: EditEv[] = [];
  verify: string | undefined; check: string | undefined; trimmed = 0; cacheBreaks = 0;
  runSeries: number[] = []; thinkBuf = "";
  phase: { phase: string; step: number; max: number; n?: number } | undefined; activity: { name: string; args: string; ms: number; ok: boolean }[] = [];
  /** One entry per loop iteration of the conversation so far, for /loop. */
  trace: TraceStep[] = [];
  running = false; ac: AbortController | undefined; runStart = 0; runTokens = 0; lastPrompt = 0;
  inflight = new Map<string, { name: string; args: string; t0: number; agent?: string; parent?: string }>();
  pendingEdits = new Map<string, EditEv>();
  streamBuf = ""; msgOpen = false; streamedThisMsg = false;
  todos: { content: string; status: string }[] = [];
  queued: { text: string; full: string }[] = [];
  overlay: Overlay | null = null; pager: Pager | null = null;
  sugg: { items: Suggestion[]; sel: number; token: Token; kind: Token["kind"]; /** the user moved into the list with the arrow keys */ nav?: boolean } | null = null; suggOff = "";
  private argPending = new Set<string>();
  private builtin: Cmd[]; private customAt = 0; private customCmds: Cmd[] = [];
  mcp: { cmd: string; tools: Tool[]; close: () => void }[] = [];
  notice = ""; noticeUntil = 0;
  pendingContext: string[] = []; modeNotice = "";
  branch: string | undefined; live: Awaited<ReturnType<typeof startLive>> | undefined;
  private out: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined; private flushT: ReturnType<typeof setTimeout> | undefined; private renderT: ReturnType<typeof setTimeout> | undefined;
  private escAt = 0; private ctrlcAt = 0; frame = 0; private stopped = false;
  /** The structured transcript the full-screen UI draws (kept in both modes so switching never loses history). */
  blocks = new BlockStore(); ui: "full" | "inline" | "remote"; full?: FullView; remote?: RemoteHooks;
  /** The transcript is drawn from structured blocks (full screen, desktop), not printed to scrollback (inline). */
  get structured() { return !!this.full || this.ui === "remote"; }
  private opts: AppOptions;
  done: Promise<number>; private resolveDone!: (n: number) => void;

  constructor(o: AppOptions) {
    this.opts = o; this.cfg = o.cfg; this.cwd = o.cwd; this.snaps = new Snapshots(o.cwd); this.version = o.version; this.persist = o.persist ?? true; this.savedDirs = this.persist ? loadState().dirs?.[o.cwd] ?? [] : [];
    this.io = { input: o.input ?? process.stdin, output: o.output ?? (process.stdout as any) };
    this.ui = o.ui ?? "inline"; this.remote = o.remote; this.screen = new Screen(this.io.output); this.files = new FileIndex(o.cwd); this.store = new SessionStore(o.cwd);
    if (this.ui === "full") this.full = new FullView(this);
    this.session = newSession(o.cwd, o.cfg.model);
    this.builtin = buildCommands();
    this.done = new Promise((r) => (this.resolveDone = r));
    const st = loadState(); this.verify = st.verifyByDir[o.cwd] ?? (detectVerify(o.cwd) || undefined);
    if (this.persist) try { this.editor.history = JSON.parse(readFileSync(join(home(), "history.json"), "utf8")).slice(0, 200); } catch { /* first run */ }
    this.buildAgent();
  }

  private warnedShadow = new Set<string>();
  /** Built-in commands plus the user's own (.amness/commands/*.md). Built-ins win name clashes. */
  get cmds(): Cmd[] {
    if (Date.now() - this.customAt > 2000) {
      this.customAt = Date.now();
      this.customCmds = loadCustomCommands([{ dir: join(this.cwd, ".amness", "commands"), scope: "project" }, { dir: join(home(), "commands"), scope: "user" }]);
    }
    const names = new Set(this.builtin.flatMap((c) => [c.name, c.alias ?? ""]));
    for (const c of this.customCmds) if (names.has(c.name) && !this.warnedShadow.has(c.name)) { this.warnedShadow.add(c.name); this.note(`your custom /${c.name} is hidden by the built-in /${c.name}; rename its file to use it`); }
    const custom = this.customCmds.filter((c) => !names.has(c.name)), taken = new Set([...names, ...custom.map((c) => c.name)]);
    const ctx: PluginCtx = { cwd: this.cwd, say: (t) => this.say(t, dim), ask: (t) => this.dispatch(t), run: async (cmd, ms) => { const out = await runShell(cmd, this.cwd, ms ?? 60_000); const m = /^exit=(\w+)\n?/.exec(out); return { code: m && /^\d+$/.test(m[1]) ? Number(m[1]) : 1, output: out.replace(/^exit=\w+\n?/, "") }; } };
    const fromPlugins: Cmd[] = this.plugins.flatMap((p) => (p.commands ?? []).filter((c) => !taken.has(c.name)).map((c) => ({ name: c.name, help: `${c.help} (plugin ${p.name})`, args: c.args, run: async (_a: App, arg: string) => { try { await c.run(ctx, arg); } catch (e) { this.note(`plugin ${p.name}: /${c.name} failed: ${(e as Error).message}`); } } })));
    return [...this.builtin, ...custom, ...fromPlugins];
  }

  // ------------------------------------------------------------------ agent plumbing
  buildAgent() {
    const cacheKey = "amness-" + createHash("sha1").update(this.cwd).digest("hex").slice(0, 12);          // stable per project: better prompt-cache hits
    const make = (c: Config) => (this.opts.makeModel ?? ((x) => createModel(x, undefined, { cacheKey })))(c);
    let w: Wired; const hooks = {
      onFallback: () => this.note(`${this.cfg.model} is unavailable; answering from ${this.cfg.fallback}`),
      onRoute: (d: { switched: boolean; reason: string }, label: string) => { this.lastRoute = label; if (d.switched) this.stepNow().notes.push(`route → ${label}: ${d.reason}`); } };
    // A bad role reference in a hand-edited config must not stop the app: say so and run with the main model only.
    try { w = wireModels(this.cfg, make(this.cfg), make, { ...hooks, cwd: this.cwd }); } catch (e) { this.note(`model roles ignored: ${(e as Error).message}`); w = wireModels({ ...this.cfg, models: undefined, fallback: undefined, router: false }, make(this.cfg), make, { ...hooks, cwd: this.cwd }); }
    this.model = w.model; this.roles = w.roles; this.wired = w;
    this.agent = createCodeAgent({
      model: this.model, modelById: (id) => w.byRef(id), cwd: this.cwd, chat: true, plans: this.cfg.plans || undefined, contextWindow: () => windowFor(this.cfg), onWindow: (w, id) => { rememberWindow(this.cfg, w, id); this.notify("info", `context window learned: ${w.toLocaleString()} tokens`, [dim(`  context window learned: ${w.toLocaleString()} tokens`)]); }, permissions: { mode: () => this.mode }, approve: this.approve, inbox: () => this.drainQueue(),
      signal: () => this.ac?.signal, budget: this.budget, verify: this.verify, check: this.check, review: this.cfg.review || undefined, lsp: this.cfg.lsp || undefined, approvalReviewer: this.cfg.approvalReviewer ? (w.approve ? { model: w.approve } : true) : undefined, quarantine: this.cfg.quarantine ? (w.quarantine ? quarantineReader(w.quarantine) : true) : undefined, dirs: this.allowedDirs, outside: (r) => this.askOutside(r), beforeShell: (cmd) => this.beforeShell(cmd), record: this.persist || undefined, models: this.roles, sandbox: () => this.cfg.sandbox ?? "off", hooks: this.hooks?.count() ? this.hooks : undefined, plugins: this.activePlugins().length ? this.activePlugins() : undefined, rules: this.rules, ...this.harnessOptions(), editedPlan: () => { const p = this.planEdit; this.planEdit = undefined; return p; }, embedder: this.cfg.embeddings && this.cfg.provider !== "anthropic" ? openaiEmbedder({ apiKey: this.cfg.apiKey, baseUrl: this.cfg.baseUrl }) : undefined, onEvent: (e) => this.onEvent(e as Ev), meta: { provider: this.cfg.provider, model: this.cfg.model },
    });
    for (const m of this.mcp) this.agent.registry.add(...m.tools);                       // attached MCP servers survive rebuilds
    if (!windowFor(this.cfg)) void detectWindow({ provider: this.cfg.provider, baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, model: this.cfg.model }).then((w) => { if (w && !windowFor(this.cfg)) { rememberWindow(this.cfg, w); this.notify("info", `context window detected: ${w.toLocaleString()} tokens`, [dim(`  context window detected: ${w.toLocaleString()} tokens`)]); } });   // a local server states it
  }
  get width() { return Math.max(24, this.screen.cols - 1); }
  /** The window shown in the sidebar, footer and /tokens: the one you set or the agent learned (a small local model), else the known size for this model. */
  get window() { return windowFor(this.cfg) ?? contextWindow(this.cfg.model); }
  get ctxPct() { return this.lastPrompt ? Math.min(99, Math.round((this.lastPrompt / this.window) * 100)) : null; }
  get cost() { const u = this.session.usage; return fmtCost(estimateCost(this.cfg.model, u.prompt, u.completion, u.cached ?? 0)); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    setShell(this.cfg.shell); { const fb = shellFallbackNote(); if (fb) this.note(fb); }
    if (!this.cfg.sandboxEngine || sandboxBackends().some((b) => b.name === this.cfg.sandboxEngine)) applySandboxEngine(this.cfg, (m) => this.note(m));   // a plugin's engine is applied once plugins load
    onRateLimitWait((ms, attempt, conc) => this.note(`rate limited by the provider: waiting ${Math.ceil(ms / 1000)}s, then retrying (attempt ${attempt}); ${conc} request${conc === 1 ? "" : "s"} at a time for now`));
    const { input, output } = this.io;
    if (this.ui !== "remote") {                                                    // a remote front end owns its own window: no terminal to set up
      input.setRawMode?.(true); input.setEncoding?.("utf8"); input.resume?.();
      output.write(PASTE_ON + FOCUS_ON);
      this.full?.enter();
      input.on("data", this.onData);
      output.on?.("resize", () => { this.full?.invalidate(); this.render(); });
      process.once("exit", this.restore);
    }
    this.files.ensure().catch(() => {});
    this.refreshBranch();
    let resumed: string | undefined;
    if (this.opts.resume) {
      const s = this.opts.resume === "last" ? this.store.latest() : this.store.load(this.opts.resume) ?? this.store.find(this.opts.resume);   // an id, or a name given with /rename
      if (s) { this.session = s; resumed = `"${s.title}" · ${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}`; this.recount(); }
    }
    if (this.structured) { if (resumed) this.blocks.loadMessages(this.session.messages); } else this.commit(welcome({ version: this.version, model: this.cfg.model, provider: this.cfg.provider, cwd: this.cwd, branch: this.branch, notes: this.agent.memory?.list().length ?? 0, verify: this.verify, mode: this.mode, resumed, tip: TIPS[Math.floor(Math.random() * TIPS.length)] }, this.width));
    this.setTitle(`Amness · ${basename(this.cwd)}`);
    if (resumed && !this.structured) this.replay();
    this.render();
    if (!(await this.trustFolder())) { this.exit(NOT_TRUSTED); return this.done; }   // before hooks, plugins or a task given on the command line
    void this.askHookTrust();
    if (this.opts.prompt) void this.dispatch(this.opts.prompt);
    return this.done;
  }
  private recount() { const l = [...this.session.messages].reverse().find((m) => m.role === "assistant" && m.usage?.prompt_tokens); this.lastPrompt = l?.usage?.prompt_tokens ?? 0; }
  private replay() {
    const tail = this.session.messages.filter((m) => (m.role === "user" || (m.role === "assistant" && m.content?.trim()))).slice(-6);
    this.commit([dim("  ── earlier in this conversation ──")]);
    for (const m of tail) this.commit(m.role === "user" ? userMessage(one((m.content ?? "").split("\n\n<attached>")[0].split("\n\n## ")[0], this.width - 4), this.width) : assistantBlock(one(m.content ?? "", this.width * 3), this.width, true));
    this.commit([dim("  ── continue below ──"), ""]);
  }
  restore = () => {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.timer);
    if (this.ui === "remote") return;
    try { if (this.full) this.full.leave(); else { this.screen.clear(); if (this.screen.alt) this.screen.leaveAlt(); } this.io.output.write(PASTE_OFF + FOCUS_OFF + "\x1b[?25h"); this.io.input.setRawMode?.(false); this.io.input.pause?.(); this.io.input.off?.("data", this.onData); } catch { /* terminal already gone */ }
  };
  exit(code = 0) {
    this.stopWarm(); this.agent.procs?.killAllNow(); void this.tracer?.close();
    if (this.running) this.ac?.abort();
    this.saveSession(); this.restore();
    const hint = this.session.turns.length ? dim(`Resume this conversation with: amness -c   (session ${this.session.id})`) : "";
    this.io.output.write(`\r\n${dim("bye 👋")}${hint ? "\r\n" + hint : ""}\r\n`);
    this.mcp.splice(0).forEach((m) => m.close());
    void this.live?.close(); this.resolveDone(code);
  }

  // ------------------------------------------------------------------ output
  /** Raw pre-styled lines: scrollback in the inline UI, a "raw" block in the full-screen UI. */
  commit(lines: string[]) { this.blocks.raw(lines); if (!this.structured) this.out.push(...lines); }
  /** Scrollback-only output for things the full-screen UI draws from structured blocks instead. */
  private inlineOnly(lines: string[]) { if (!this.structured) this.out.push(...lines); }
  private notify(level: "info" | "warn" | "error" | "ok", text: string, inline: string[]) { if (this.structured) this.blocks.notice(level, text); else this.out.push(...inline); }
  private addUser(text: string, note?: string, queued?: boolean) { this.blocks.addUser(text, note, queued); this.inlineOnly(userMessage(text, this.width, note ?? "")); }
  say(text: string | string[], paint: (s: string) => string = (s) => s) {
    for (const t of ([] as string[]).concat(text)) this.commit(["", ...t.split("\n").flatMap((p) => wrapAnsi(paint(p), this.width - 2)).map((l) => "  " + l)]);
  }
  note(text: string, ms = 3000) {
    if (this.remote) { this.remote.toast("info", text); return; }
    if (this.full && ms <= 5000) { this.full.toast(text, "info", ms); this.render(); setTimeout(() => this.render(), ms + 40); return; }
    this.notice = text; this.noticeUntil = Date.now() + ms; this.render();
    setTimeout(() => { if (Date.now() >= this.noticeUntil) this.render(); }, ms + 30);               // redraw when it expires so the footer returns to normal
  }

  render = () => {
    if (this.stopped) return;
    if (this.remote) { this.remote.changed(); return; }
    if (this.full) { clearTimeout(this.renderT); this.renderT = undefined; return this.full.draw(); }
    if (this.pager) return;
    clearTimeout(this.renderT); this.renderT = undefined;
    const w = this.width, live: string[] = [];
    let cursor: { row: number; col: number } | undefined;
    if (this.streamBuf.trim()) { const r = renderMarkdown(this.streamBuf, w - 2).slice(-6); live.push(...r.map((l, i) => (this.msgOpen || i ? "  " : bold("● ")) + l)); }
    const now = Date.now();
    const latest = new Map<string, string>(); for (const [id, t] of this.inflight) if (t.agent && t.agent !== "lead") latest.set(t.parent ?? t.agent, id);        // one line per subagent: its newest step
    for (const [id, t] of this.inflight) {
      const subagent = t.agent && t.agent !== "lead";
      if (subagent && latest.get(t.parent ?? t.agent!) !== id) continue;
      live.push(`${subagent ? dim("  │ ") : ""}${cyan(SPIN[this.frame % SPIN.length])} ${toolCall(t.name, t.args)} ${dim(fmtDuration(now - t.t0))}${subagent ? dim(`  · ${t.agent}, step ${this.blocks.kids(t.parent ?? "").length || 1}`) : ""}`);
    }
    if (this.running && this.todos.length) live.push(...todoList(this.todos, w));
    if (this.running && this.thinkBuf.trim() && !this.streamBuf.trim()) {                      // the model's reasoning summary, as it forms (OpenAI Responses)
      const last = this.thinkBuf.replace(/\s+/g, " ").trim().slice(-(w - 8));
      live.push(dim(`  ✻ ${last.replace(/^\S*\s/, (m) => (cellWidth(last) >= w - 8 ? "" : m))}`));
    }
    if (this.running) {
      const glyph = fg(at(palette.brand, (this.frame % 30) / 30), GLYPHS[this.frame % GLYPHS.length]), spark = this.runSeries.length > 1 ? " " + sparkline(this.runSeries, 10) : "";
      live.push(`${glyph} ${shimmer((this.mode === "plan" ? "Planning" : "Working") + "…", this.frame)}${dim(` (${fmtDuration(now - this.runStart)} · ↓ ${fmtTokens(this.runTokens)} tokens`)}${spark}${dim(" · esc to interrupt)")}`);
    }
    for (const q of this.queued) live.push(dim(`  ▸ queued: ${one(q.text, w - 14)}`));
    if (live.length) live.unshift("");
    if (this.overlay) {
      const d = this.overlay.render(w), at = live.length;
      live.push(...d.lines); if (d.cursor) cursor = { row: at + d.cursor.row, col: d.cursor.col };
    } else {
      live.push("");                                                              // breathing room above the input box
      if (this.sugg) live.push(...this.suggLines(w));
      live.push(gray("─".repeat(w)));
      const r = this.editor.render(w), prompt = this.vimNormal ? bold(magenta("N ")) : this.editor.text.startsWith("!") ? yellow("! ") : this.editor.text.startsWith("#") ? green("# ") : bold(cyan("❯ "));
      const at = live.length;
      live.push(...r.lines.map((l, i) => (i === 0 ? prompt + this.styleInput(l.slice(2)) : "  " + this.styleInput(l.slice(2)))));
      cursor = { row: at + r.cursor.row, col: r.cursor.col };
      live.push(gray("─".repeat(w)));
    }
    live.push(footer({ mode: this.mode, model: this.cfg.model, provider: this.cfg.provider, ctxPct: this.ctxPct, cost: this.cost, branch: this.branch, queued: this.queued.length, hint: this.overlay ? undefined : this.hint(), quiet: !!this.overlay, notice: this.notice && now < this.noticeUntil ? this.notice : undefined }, w));
    this.screen.frame(this.out.splice(0), live, cursor);
  };
  schedule() { if (!this.renderT) this.renderT = setTimeout(this.render, 12); }
  private styleInput(l: string) { return l.replace(/(@[^\s]+)/g, (m) => cyan(m)).replace(/\[Pasted text #\d+ \+\d+ lines?\]/g, (m) => magenta(m)); }
  private hint() {
    if (this.editing) return `editing your message ${this.editing.turn + 1} · enter resends it from there · esc cancels`;
    if (!this.editor.empty) return this.running ? "enter queues your message" : undefined;
    if (this.running) return "type to steer · esc to interrupt";
    const p = this.ctxPct;
    return p !== null && p >= 75 ? (p >= 90 ? "context almost full · /compact" : "context filling up · /compact") : "? for shortcuts · ctrl+p commands";
  }
  setTitle(t: string) { if (this.ui !== "remote" && this.io.output.isTTY !== false) this.io.output.write(`\x1b]0;${t}\x07`); }
  private suggLines(w: number): string[] {
    const s = this.sugg!, { rows, above, below } = menuRows(s.items, s.sel, Math.min(12, Math.max(4, this.screen.rows - 8)));
    const lines = rows.map((r) => {
      if ("head" in r) return dim(`  ── ${r.head} ${"─".repeat(Math.max(2, 20 - r.head.length))}`);
      const it = s.items[r.item], on = r.item === s.sel, label = s.kind === "file" ? it.label : it.label.padEnd(16);
      return (on ? cyan("❯ ") + bold(cyan(label)) : "  " + label) + (it.detail ? "  " + (on ? gray(it.detail) : dim(it.detail)) : "");
    }).map((l) => (cellWidth(l) > w ? l.slice(0, w + 12) : l));
    if (above || below) lines.push(dim(`  ${s.sel + 1}/${s.items.length}  ${above ? "↑" : " "}${below ? "↓" : " "}  ↑↓ move · PgUp/PgDn page`));
    return lines;
  }
  private tick = () => { this.frame++; this.render(); };
  private ensureTimer() { if (!this.timer) this.timer = setInterval(this.tick, 100); }
  private idleTimer() { if (!this.running && !this.inflight.size && this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  // ------------------------------------------------------------------ input
  onData = (d: Buffer | string) => {
    for (const k of this.keys.feed(typeof d === "string" ? d : d.toString("utf8"))) this.handleKey(k);
    clearTimeout(this.flushT);
    if (this.keys.pending) this.flushT = setTimeout(() => { for (const k of this.keys.flush()) this.handleKey(k); }, 35);
  };

  handleKey(k: Key) {
    if (k.name === "focusin" || k.name === "focusout") { this.focused = k.name === "focusin"; return; }
    if (k.name === "mouse" && k.mouse) { this.full?.mouse(k.mouse); return; }
    if (this.pager) return this.pager.key(k);
    if (this.overlay) { this.overlay.key(k); this.schedule(); return; }
    if (this.full?.find && this.full.findKey(k)) return this.render();
    const ed = this.editor;
    if (this.cfg.vim && this.vim.mode === "normal" && !this.sugg) {                      // vim normal mode: keys move and edit instead of typing
      const r = this.vim.key(ed, k);
      if (r === "submit") return void this.submit();
      if (r) { this.escAt = 0; return this.after(false); }
    }
    if (this.full) {                                                        // full-screen only keys (scrolling, sidebar, details, theme)
      if (this.full.key(k.name, k.ctrl)) return;
      if (k.ctrl && k.name === "b") { this.full.showSidebar = !this.full.showSidebar; this.full.invalidate(); return this.render(); }
      if (k.ctrl && k.name === "o") { this.full.expandAll = !this.full.expandAll; this.full.toast(this.full.expandAll ? "all tool output expanded" : "tool output collapsed"); return this.render(); }
      if (k.ctrl && k.name === "t") return void this.runCommand("/theme");
      if (k.ctrl && k.name === "l") { this.full.invalidate(); return this.render(); }
    }
    if (k.ctrl && k.name === "f" && this.full) { this.full.openFind(); return this.render(); }
    if (k.alt && (k.name === "up" || k.name === "down") && this.full) return this.full.jumpPrompt(k.name === "up" ? -1 : 1);
    if (k.ctrl && k.name === "r") return void this.openHistorySearch();
    if (k.ctrl && k.name === "g") return this.editInEditor();
    if (k.ctrl && k.name === "v") return this.pasteImage();
    if (k.ctrl && k.name === "c") return this.ctrlC();
    if (k.ctrl && k.name === "d") { if (ed.empty) return this.exit(0); }
    if (k.ctrl && k.name === "o") return this.openTranscript();
    if (k.ctrl && k.name === "p") return void this.openPalette();
    if (k.alt && k.name === "char" && k.text === "m") return void this.runCommand("/model");
    if (k.ctrl && k.name === "l") { this.io.output.write("\x1b[2J\x1b[3J\x1b[H"); this.screen.height = 0; return this.render(); }
    if (k.name === "backtab") return this.cycleMode();
    if (k.name === "escape" && this.editing && !this.sugg && !this.running) { this.editing = undefined; ed.clear(); this.note("edit cancelled"); return this.render(); }
    if (k.name === "escape" && this.cfg.vim && this.vim.mode === "insert" && !this.running && !this.sugg) { this.vim.toNormal(ed); return this.render(); }
    if (k.name === "escape") return this.escape();
    if (k.name === "tab" && this.sugg) return this.acceptSugg(false);
    if (k.name === "enter" && !k.alt && !k.shift) {
      if (this.sugg && this.sugg.items.length) { const it = this.sugg.items[this.sugg.sel]; if (!(this.sugg.kind === "slash" && ed.text.trim() === it.label) && !(this.sugg.kind === "arg" && (this.sugg.items.some((x) => x.label === this.sugg!.token.query) || (it.open && !this.sugg.nav)))) return this.acceptSugg(true); }
      if (ed.text.slice(0, ed.cursorIndex).endsWith("\\")) { ed.backspace(); ed.newline(); return this.after(); }
      return void this.submit();
    }
    if (this.sugg && (k.name === "pageup" || k.name === "pagedown")) { const n = this.sugg.items.length; this.sugg.sel = Math.max(0, Math.min(n - 1, this.sugg.sel + (k.name === "pageup" ? -8 : 8))); return this.render(); }
    if (k.name === "up" || k.name === "down") {
      if (this.sugg) { const n = this.sugg.items.length; this.sugg.sel = (this.sugg.sel + (k.name === "up" ? n - 1 : 1)) % n; this.sugg.nav = true; return this.render(); }
      if (!ed.vertical(k.name === "up" ? -1 : 1)) k.name === "up" ? ed.historyPrev() : ed.historyNext();
      return this.after(false);
    }
    if (k.name === "char" && k.text === "?" && ed.empty) return this.openPager(helpLines(this.cmds, this.screen.cols - 1), "help");
    if (this.full && (k.name === "char" || k.name === "paste" || k.name === "backspace")) this.full.clearSelection();
    if (editKey(ed, k)) { this.escAt = 0; return this.after(); }
  }
  private after(suggest = true) { if (suggest) this.updateSugg(); this.render(); }

  /**
   * The completion menu for `text` with the cursor at `cursor`: slash commands, a command's arguments, or @files. Shared by the terminal input and the desktop composer.
   * `later` is called once options that are still loading (model lists, file index) have arrived.
   */
  suggestionsFor(text: string, cursor: number, later?: () => void): { token: Token; items: Suggestion[] } | null {
    const tok = tokenAtCursor(text, cursor); if (!tok) return null;
    let items: Suggestion[] = [];
    if (tok.kind === "slash") items = rankCommands(tok.query, this.cmds);
    else if (tok.kind === "arg") {
      const cmd = this.cmds.find((c) => c.name === tok.cmd || c.alias === tok.cmd);
      if (cmd) {
        const r = argOptions(this, cmd.name, tok.words ?? []), pk = `${cmd.name}|${(tok.words ?? []).join(" ")}`;
        if (r.pending && later && !this.argPending.has(pk)) { this.argPending.add(pk); void r.pending.catch(() => {}).then(() => { this.argPending.delete(pk); later(); }); }
        items = r.options.map((o) => ({ o, s: fuzzyScore(tok.query, o.value) })).filter((x): x is { o: typeof x.o; s: number } => x.s !== null)
          .sort((x, y) => (tok.query ? y.s - x.s : 0)).map(({ o }) => ({ label: o.value, insert: o.value + (o.more ? " " : ""), detail: o.detail, more: o.more, open: r.open }));
      }
    } else {
      if (!this.files.fresh() && later) void this.files.ensure().then(later, () => {});      // list still loading: fill the popup in once it arrives
      items = rankFiles(tok.query, this.files.files);
    }
    return { token: tok, items };
  }
  private updateSugg() {
    const text = this.editor.text, tok = tokenAtCursor(text, this.editor.cursorIndex), key = tok ? `${tok.kind}:${tok.query}` : "";
    if (!tok || key === this.suggOff) { this.sugg = null; return; }
    this.suggOff = "";
    const items = this.suggestionsFor(text, this.editor.cursorIndex, () => { this.updateSugg(); this.render(); })?.items ?? [];
    const same = this.sugg && this.sugg.kind === tok.kind && this.sugg.token.query === tok.query, keep = same ? this.sugg!.sel : 0;
    this.sugg = items.length ? { items, sel: Math.min(keep, items.length - 1), token: tok, kind: tok.kind, nav: same ? this.sugg!.nav : false } : null;
    if (!this.sugg) return;
    this.schedule();
  }
  acceptSuggPublic(fromEnter: boolean) { if (this.sugg) this.acceptSugg(fromEnter); }
  private acceptSugg(fromEnter: boolean) {
    const s = this.sugg!, r = applySuggestion(this.editor.text, s.token, s.items[s.sel]);
    this.editor.setText(r.text, r.cursor); this.sugg = null; this.suggOff = "";
    if (fromEnter && s.kind === "slash" && !this.cmds.find((c) => "/" + c.name === s.items[s.sel].label)?.args) return void this.submit();
    if (fromEnter && s.kind === "arg" && !s.items[s.sel].more) return void this.submit();     // a finished value: run the command
    this.updateSugg(); this.render();
  }

  private escape() {
    if (this.full?.clearSelection()) return this.render();
    if (this.sugg) { this.suggOff = `${this.sugg.token.kind}:${this.sugg.token.query}`; this.sugg = null; return this.render(); }
    if (this.running) { this.ac?.abort(); return this.note("interrupting after the current step…"); }
    const now = Date.now();
    if (now - this.escAt < 700) { this.escAt = 0; if (!this.editor.empty) { this.editor.clear(); return this.render(); } return void this.openRewind(); }
    this.escAt = now; if (!this.editor.empty) this.note("press esc again to clear"); else if (this.session.turns.length) this.note("press esc again to rewind");
  }
  private ctrlC() {
    const now = Date.now();
    if (this.running) { this.ac?.abort(); this.ctrlcAt = 0; return this.note("interrupting after the current step…"); }
    if (!this.editor.empty) { this.editor.clear(); this.sugg = null; return this.render(); }
    if (now - this.ctrlcAt < 2000) return this.exit(0);
    this.ctrlcAt = now; this.note("press ctrl-c again to exit");
  }
  /** Stop the running turn after its current step (Esc in the terminal, Stop in the desktop). */
  interrupt() { if (this.running) { this.ac?.abort(); this.note("interrupting after the current step…"); } }
  cycleMode() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }
  setMode(m: PermMode) {
    if (m === this.mode) return;
    this.mode = m;
    this.modeNotice = m === "plan" ? "[mode: plan mode is ON. You are read-only. Investigate, then present your plan with exit_plan_mode.]" : this.mode === "yolo" ? "" : `[mode: permission mode is now "${m}"; plan mode is off.]`;
    if (m === "default") this.note("default mode: asks before edits and commands");
    else if (m === "yolo" && (this.cfg.sandbox ?? "off") === "off" && sandboxKind()) this.note("tip: /sandbox workspace makes yolo much safer (commands cannot write outside the project)");
    else this.render();    // other modes announce themselves in the footer label
  }

  // ------------------------------------------------------------------ submitting
  async submit() {
    const text = this.editor.submit(); this.sugg = null; this.suggOff = "";
    if (!text) return this.render();
    this.saveHistory();
    if (this.editing && !text.startsWith("/")) { const t = this.editing.turn; this.editing = undefined; await this.editMessage(t, text); return; }
    await this.submitText(text);
  }
  /** A finished message from any front end: a command, !shell, #note or a chat turn; while a turn runs, chat waits in the queue and only live commands run. */
  async submitText(text: string) {
    if (this.running) {
      if (text.startsWith("/")) { const n = text.slice(1).split(/\s+/)[0]; const c = this.cmds.find((x) => x.name === n); if (c?.live) return void (await this.runCommand(text)); this.note("finish or interrupt (esc) before running commands"); return; }
      const { text: full, attached } = expandMentions(text, this.cwd);
      this.queued.push({ text, full }); void attached; return this.render();
    }
    await this.dispatch(text);
  }
  async dispatch(text: string) {
    this.stopWarm();
    if (text.startsWith("/")) return this.runCommand(text);
    if (text.startsWith("!")) return this.bash(text.slice(1).trim());
    if (text.startsWith("#")) return this.remember(text.slice(1).trim());
    await this.turn(text);
  }
  async runCommand(text: string) {
    const [name, ...rest] = text.slice(1).split(/\s+/), args = text.slice(1).slice(name.length).trim();
    const c = this.cmds.find((x) => x.name === name || x.alias === name);
    if (!c) { this.commit(["", `  ${red("✗")} unknown command /${name}. Type /help.`]); return this.render(); }
    void rest;
    try { await c.run(this, args); } catch (e) { this.commit(["", `  ${red("✗")} /${name}: ${(e as Error).message}`]); }
    this.render();
  }
  private drainQueue(): string[] {
    const q = this.queued.splice(0);
    for (const m of q) this.addUser(m.text, "sent while working");
    this.schedule();
    return q.map((m) => m.full);
  }

  async bash(cmd: string) {
    if (!cmd) return void this.say("After ! type a command to run it now, for example !ls or !git status. Its output is added to your next message.", dim);
    const { runShell, withNotFoundHint } = await import("../../src/index.ts");
    const callId = "!" + Date.now();
    this.blocks.toolStart(callId, "sh", JSON.stringify({ cmd })); this.inlineOnly(["", toolHeader("sh", JSON.stringify({ cmd }), null).replace("Bash", "Bash!")]); this.render();
    const out = withNotFoundHint(await runShell(cmd, this.cwd, 120_000), () => false, true);
    this.blocks.toolEnd(callId, out); this.inlineOnly(toolResult("sh", "{}", out, this.width));
    this.pendingContext.push(`I ran \`${cmd}\` in my terminal:\n${out.slice(0, 6000)}`);
    this.render();
  }
  remember(note: string) {
    const mem = this.agent.memory;
    if (!note || !mem) return this.note("nothing to remember");
    const e = mem.save({ name: slugify(note.split(/\s+/).slice(0, 6).join(" ")), type: "project", description: one(note, 120), content: note });
    if (this.structured) this.blocks.notice("ok", `remembered: ${note}  (saved to ${e.scope} memory as "${e.name}")`); else this.commit(["", `  ${green("✓")} ${dim("remembered:")} ${note}`, `  ${dim(`saved to ${e.scope} memory as "${e.name}"`)}`]);
    this.render();
  }

  async turn(text: string) {
    const { text: expanded, attached, images: found, problems } = expandMentions(text, this.cwd);
    const vision = visionLikely(this.cfg.provider, this.cfg.model), images = vision ? found : [];
    for (const p of problems) this.note(p);
    if (found.length && !vision) this.note(`${this.cfg.model} does not look like a vision model: ${found.length} image(s) not sent. Use a model that accepts images (for example gpt-5 or Claude).`);
    const prefix = [this.modeNotice, ...this.pendingContext].filter(Boolean).join("\n\n"); this.modeNotice = ""; this.pendingContext = [];
    const full = prefix ? `${prefix}\n\n${expanded}` : expanded;
    this.addUser(text, attachedNote(attached) || undefined);
    if (!this.session.title) this.session.title = one(text, 60);
    const turn: Turn = { at: this.session.messages.length, text, t: Date.now(), snaps: {} };
    this.session.turns.push(turn);
    this.turnUsage0 = { ...this.session.usage }; this.running = true; this.ac = new AbortController(); this.runStart = Date.now(); this.runTokens = 0; this.todos = []; this.runSeries = []; this.phase = undefined; this.activity = [];
    this.setTitle(`● working · ${basename(this.cwd)}`);
    Object.assign(this.budget, { tokens: 0, cachedTokens: 0, calls: 0, t0: Date.now(), maxTokens: this.cfg.maxTokens, maxMs: 60 * 60_000 });
    this.ensureTimer(); this.render();
    let ok = false, badKey = false;
    try {
      const r = await this.agent.chat(this.session.messages, full, { images });
      this.session.messages = r.messages; ok = true;
      if (r.stopped === "budget") { const head = r.text.split("\n")[0]; this.notify("warn", head, ["", `  ${yellow("$")} ${head}`]); }
      else if (r.stopped === "stuck") this.notify("warn", r.text + "; tell it what to try next", ["", `  ${yellow("!")} ${r.text}; tell it what to try next`]);
      else if (r.stopped === "maxSteps") this.notify("warn", "stopped after the maximum number of steps; send a message to continue", ["", `  ${yellow("!")} stopped after the maximum number of steps; send a message to continue`]);
    } catch (e) {
      this.session.turns.pop();
      if (prefix) this.pendingContext.unshift(prefix);                              // the shell output or mode note this turn carried is not lost: the next message (or the retry) sends it again
      const msg = (e as Error).message;
      badKey = /\b401\b|unauthori[sz]ed|authentication[_ ]error|invalid[_ ]api[_ ]key|incorrect api key|(api[_ ]key|token|credential)s?\b.{0,30}\b(expired|revoked|invalid|disabled)/i.test(msg);   // not any 403 or "expired": those also mean region limits or an expired response id. A local server started with a key answers 401 too
      this.notify("error", one(msg, 400) + (badKey ? "  (key rejected: enter a new one)" : ""), ["", `  ${red("✗")} ${one(msg, this.width * 2)}`]);
    }
    this.flushStream(true); this.blocks.endAssistant(); this.blocks.endThinking(); this.blocks.closeRunning(ok ? "ended without a result" : "interrupted");
    const secs = Date.now() - this.runStart;
    { const u = this.session.usage, u0 = this.turnUsage0; this.lastTurnCost = estimateCost(this.cfg.model, u.prompt - u0.prompt, u.completion - u0.completion, (u.cached ?? 0) - (u0.cached ?? 0)); }   // subagents included: their usage is added to the session too
    const turnCost = this.lastTurnCost !== null ? fmtCost(this.lastTurnCost) : "";
    if (ok && (secs > 4000 || this.runTokens > 2000)) this.inlineOnly([dim(`  ✻ Worked for ${fmtDuration(secs)} · ${fmtTokens(this.runTokens)} tokens${turnCost ? ` · ≈ ${turnCost}` : ""}`)]);
    if (this.todos.length && this.todos.some((t) => t.status !== "done")) this.inlineOnly(todoList(this.todos, this.width));
    this.todos = []; this.inflight.clear(); this.running = false; this.ac = undefined; this.thinkBuf = ""; this.scheduleWarm();
    this.setTitle(`${ok ? "✔" : "✗"} Amness · ${basename(this.cwd)}`);
    if (secs > 20_000) { this.io.output.write("\x07"); this.notifyAway(ok ? "Amness finished" : "Amness stopped", `${this.session.title || basename(this.cwd)} · ${fmtDuration(secs)}${turnCost ? ` · ≈ ${turnCost}` : ""}`); }   // a long turn ended: nudge the user, even if they switched tabs
    this.saveSession(); this.refreshBranch(); this.idleTimer(); this.render();
    if (badKey && await this.reconnect(text)) return;
    if (this.queued.length) { const q = this.queued.splice(0); await this.dispatch(q.map((m) => m.text).join("\n\n")); }
  }

  /** The provider rejected the key (expired or revoked): ask for a new one, save it, and send the message again. */
  private async reconnect(text: string): Promise<boolean> {
    const id = keyIdOf(this.cfg), label = this.cfg.server ?? PROVIDERS[this.cfg.provider].label;   // a saved server has its own key
    if (keyFor(id).source === "env") { this.note(`${label}: the key comes from an environment variable. Update it and restart, or unset it and use /connect.`); return false; }
    const key = await this.askText(`${label} ${this.cfg.apiKey ? "key was rejected. New API key" : "asks for a key. API key or token"} (hidden; ${where()}), Esc to skip`, { secret: true });
    if (!key) return false;
    storeKey(id, key); this.cfg.apiKey = key; this.buildAgent();
    this.note(`${label} reconnected (${noStore() ? "this session only" : where()}); sending your message again`);
    await this.dispatch(text);
    return true;
  }

  // ------------------------------------------------------------------ events from the agent
  private stepNow(): TraceStep { if (!this.trace.length) this.trace.push({ n: 1, t0: Date.now(), ms: 0, prompt: 0, completion: 0, tools: [], notes: [] }); return this.trace[this.trace.length - 1]; }
  /** The session's trace (local JSONL file, plus an OpenTelemetry collector when AMNESS_OTLP is set). */
  tracer?: Tracer; private tracerFor = "";
  private trace_(e: Ev) {
    if (!this.persist) return;
    if (!this.tracer || this.tracerFor !== this.session.id) { void this.tracer?.close(); this.tracerFor = this.session.id; this.tracer = new Tracer({ file: join(this.cwd, ".amness", "traces", `${this.session.id}.jsonl`), otlp: process.env.AMNESS_OTLP, sessionId: this.session.id, model: this.cfg.model }); }
    this.tracer.event(e as any);
  }
  onEvent(e: Ev) {
    this.live?.onEvent(e as any); this.trace_(e);
    const sub = e.agent && e.agent !== "lead" ? e.agent : undefined, w = this.width;
    switch (e.kind) {
      case "thinking": if (!sub) { this.thinkBuf = (this.thinkBuf + e.delta).slice(-600); this.blocks.streamThinking(e.delta); } break;
      case "turn": this.session.usage.prompt += e.prompt; this.session.usage.completion += e.completion; this.session.usage.calls++; if (!sub) { const s = this.stepNow(); s.ms = Date.now() - s.t0; s.prompt = e.prompt; s.completion = e.completion; s.cached = e.cached; }
        this.session.usage.cached = (this.session.usage.cached ?? 0) + e.cached; if (!sub) this.lastCached = e.cached; this.session.usage.reasoning = (this.session.usage.reasoning ?? 0) + e.reasoning;
        this.session.usage.series = [...(this.session.usage.series ?? []), e.prompt].slice(-200); this.session.usage.requests = [...(this.session.usage.requests ?? []), { prompt: e.prompt, completion: e.completion, cached: e.cached, reasoning: e.reasoning, step: e.step + 1, agent: sub, at: Date.now() }].slice(-200); this.runSeries = [...this.runSeries, e.completion].slice(-40); if (!sub) { this.runTokens = e.tokens; this.lastPrompt = e.prompt; } else this.runTokens += e.completion; break;
      case "text": if (!sub) { this.thinkBuf = ""; this.blocks.endThinking(); this.blocks.streamAssistant(e.delta); this.streamBuf += e.delta; this.streamedThisMsg = true; this.flushStream(false); } break;
      case "assistant": if (!sub) { if (!this.streamedThisMsg || e.streamed === false) { this.blocks.setAssistant(e.text); this.streamBuf = e.text; this.streamedThisMsg = false; } this.blocks.endAssistant(); this.flushStream(true); } break;
      case "toolstart": this.blocks.toolStart(e.id, e.name, e.args, sub, (e as any).parent); this.inflight.set(e.id, { name: e.name, args: e.args, t0: Date.now(), agent: sub, parent: (e as any).parent }); this.ensureTimer(); break;
      case "edit": this.pendingEdits.set(e.path, e); this.edits.push(e); snapshot(this.session.turns.at(-1), e.path, e.before); break;
      case "tool": {
        const t = this.inflight.get(e.id ?? ""); this.inflight.delete(e.id ?? ""); this.idleTimer();
        const bad = isFailure(e.result);
        if (!sub) this.stepNow().tools.push({ name: e.name, args: e.args, ms: t ? Date.now() - t.t0 : 0, ok: !bad });
        if (!sub && e.name !== "todo_write") this.activity = [...this.activity, { name: e.name, args: e.args, ms: t ? Date.now() - t.t0 : 0, ok: !bad }].slice(-12);
        let editPath = ""; if ((e.name === "write_file" || e.name === "edit_file") && !bad) { try { editPath = JSON.parse(e.args).path; } catch { /* keep empty */ } }
        let ed = editPath ? this.pendingEdits.get(editPath) : undefined; if (editPath) this.pendingEdits.delete(editPath);
        let more: EditEv[] = [];
        if (e.name === "apply_patch" && !bad) { [ed, ...more] = [...this.pendingEdits.values()]; this.pendingEdits.clear(); editPath = ed?.path ?? ""; }
        this.blocks.toolEnd(e.id ?? "", e.result, ed ? { path: ed.path, created: ed.created, added: ed.added, removed: ed.removed, diff: ed.diff } : undefined);
        for (const x of more) { const id = `${e.id}#${x.path}`; this.blocks.toolStart(id, "edit_file", JSON.stringify({ path: x.path })); this.blocks.toolEnd(id, `patched ${x.path}`, { path: x.path, created: x.created, added: x.added, removed: x.removed, diff: x.diff }); }
        if (sub) break;                                  // a subagent's steps live inside its own card (full-screen) or the live status line (inline), never scattered in the transcript
        if (e.name === "todo_write") break;
        const lines = ["", toolHeader(e.name, e.args, !bad)];
        if (ed) { lines.push(`  ${gray("⎿")}  ${dim(editSummary(ed))}`, ...renderDiff(ed.diff, w)); for (const x of more) lines.push(`  ${gray("⎿")}  ${dim(editSummary(x))}`, ...renderDiff(x.diff, w)); }
        else if (!editPath) lines.push(...toolResult(e.name, e.args, e.result, w));
        void t; this.inlineOnly(lines); break;
      }
      case "todos": this.todos = e.todos; break;
      case "review": if (!sub) { this.stepNow().notes.push(e.pass ? "reviewer: no problems" : "reviewer: " + e.findings.join("; ").slice(0, 200)); if (!e.pass) this.notify("warn", `reviewer found ${e.findings.length} problem${e.findings.length === 1 ? "" : "s"}: ${one(e.findings.join("; "), 300)}`, [dim(`  ✖ reviewer: ${one(e.findings.join("; "), w - 16)}`)]); else this.note("reviewer: no problems found"); } break;
      case "audit": if (!sub && (e.changed.length || e.notes.length)) {
        const line = `${e.changed.length} file${e.changed.length === 1 ? "" : "s"} changed${e.testsAfterLastEdit === true ? " · tests passed after the last edit" : ""}`;
        this.stepNow().notes.push("audit: " + line + (e.notes.length ? " · " + e.notes.join("; ") : ""));
        this.notify(e.notes.length ? "warn" : "ok", `${line}${e.notes.length ? ". Note: " + e.notes.join("; ") : ""}`, [dim(`  ◐ ${line}${e.notes.length ? " · " + e.notes.join("; ") : ""}`)]);
      } break;
      case "skill": this.skillsUsed.set(e.name, (this.skillsUsed.get(e.name) ?? 0) + 1); this.stepNow().notes.push(`skill ${e.name} loaded`); break;
      case "hook": this.stepNow().notes.push(`hook ${e.event}${e.blocked ? " blocked" : ""}: ${one(e.detail, 100)}`); if (e.blocked || e.detail !== "added context") this.notify(e.blocked ? "warn" : "info", `hook ${e.event}: ${one(e.detail, 200)}`, [dim(`  ⚙ hook ${e.event}: ${one(e.detail, w - 20)}`)]); break;
      case "policy": if (!sub) this.policyLog = [...this.policyLog, `${e.action.padEnd(5)} ${e.tool}: ${e.reason}`].slice(-20); break;
      case "cachebreak": if (!sub) { this.cacheBreaks++; this.stepNow().notes.push("cache break: " + e.reason); } break;
      case "trim": if (!sub) { this.trimmed += e.saved; this.stepNow().notes.push(`trimmed ~${fmtTokens(Math.round(e.saved / 4))} tokens (${e.what})`); } break;
      case "phase": if (!sub) {
        this.phase = { phase: e.phase, step: e.step, max: e.max, n: e.n };
        if (e.phase === "model") this.trace = [...this.trace, { n: this.trace.length + 1, t0: Date.now(), ms: 0, prompt: 0, completion: 0, tools: [], notes: [] }].slice(-300);
        else if (e.phase === "tools") this.stepNow().parallel = e.n;
        else if (e.phase === "verify") this.stepNow().notes.push("verify gate running");
      } break;
      case "finish": if (!sub) { this.flushStream(true); this.blocks.summary(e.summary); this.inlineOnly(["", ...renderMarkdown(e.summary, w - 4).map((l, i) => (i ? "    " : "  " + green("✔ ")) + l)]); } break;
      case "rejected": this.stepNow().notes.push("finish rejected: " + one(e.detail, 120)); this.notify("warn", `finish rejected by verification: ${one(e.detail, 300)}`, ["", `  ${yellow("⛔")} ${dim("finish rejected by verification:")} ${one(e.detail, w - 10)}`]); break;
      case "denied": this.stepNow().notes.push("denied: " + one(e.detail, 120)); this.notify("warn", `denied: ${one(e.detail, 300)}`, ["", `  ${red("⊘")} ${dim("denied: " + one(e.detail, w - 14))}`]); break;
      case "nudge": if (sub) break; this.stepNow().notes.push("nudged: " + one(e.detail, 80)); { const msg = /^budget \d+% used/.test(e.detail) ? `${e.detail}: asked the model to wrap up` : /^(step limit|stagnation|stuck|explored)/.test(e.detail) ? e.detail : "nudged the model to act instead of describing"; this.notify("info", msg, [dim(`  ↻ ${msg}`)]); } break;
      case "repair": { const what = e.fixed ? "corrected a tool call" : "malformed tool call sent back"; this.stepNow().notes.push(`${what}: ` + one(e.detail, 100)); this.notify("info", `${what}: ${one(e.detail, 200)}`, [dim(`  ⚒ ${what}: ${one(e.detail, w - 30)}`)]); break; }
      case "loop": this.stepNow().notes.push("loop guard: " + one(e.detail, 100)); this.notify("info", "blocked a repeated identical call", [dim("  ∞ blocked a repeated identical call")]); break;
      case "rollover": this.notify("info", "context getting large: continued from a handoff note", [magenta("  ⟳ ") + dim("context getting large: continued from a handoff note")]); break;
      case "budget": if (sub) break; if (/exhausted/.test(e.detail)) this.notify("error", e.detail, ["", `  ${red("$")} ${e.detail}`]); else this.notify("warn", `${e.detail}: writing a final report`, [dim(`  $ ${e.detail}: writing a final report`)]); break;
      case "aborted": this.notify("warn", "interrupted. Your progress is kept; send a message to continue.", ["", `  ${yellow("⏹")} ${dim("interrupted. Your progress is kept; send a message to continue.")}`]); break;
      case "steer": case "tools": break;
    }
    this.schedule();
  }

  /** Stream assistant text: complete paragraphs are committed to scrollback immediately; the unfinished tail stays in the live region. */
  flushStream(final: boolean) {
    const w = this.width;
    if (this.structured) { if (final) { this.streamBuf = ""; this.msgOpen = false; this.streamedThisMsg = false; } return; }          // the full-screen UI draws the block store
    if (final) { const rest = this.streamBuf; this.streamBuf = ""; if (rest.trim()) { this.commit(assistantBlock(rest, w, !this.msgOpen).map((l, i) => (i === 0 && !this.msgOpen ? ["", l] : [l])).flat()); this.msgOpen = true; } this.msgOpen = false; this.streamedThisMsg = false; return; }
    const { done, rest } = takeCompleteBlocks(this.streamBuf);
    if (done.trim()) { this.commit(assistantBlock(done, w, !this.msgOpen).map((l, i) => (i === 0 && !this.msgOpen ? ["", l] : [l])).flat()); this.msgOpen = true; }
    this.streamBuf = rest;
  }

  // ------------------------------------------------------------------ permission prompts
  /** Whether /undo can take a command back, in words. Snapshots cover the working tree (not files git ignores) and need git; history and other machines are out of reach. */
  undoFor(cmd: string, risk: CommandRisk): { can: "yes" | "partly" | "no"; text: string } {
    if (risk.irreversible) return { can: "no", text: `Cannot be undone: it ${risk.irreversible}` };
    if (!this.branch) return { can: "no", text: "Cannot be undone: this folder is not a git repository, so there is no snapshot for /undo" };
    if (/\bgit\s+(reset|rebase|branch\s+-D|commit\s+--amend)\b/.test(cmd)) return { can: "partly", text: "/undo puts your files back, but not git history (git reflog can)" };
    if (/\bgit\s+clean\b[^;&|]*\s-\w*x|\brm\b/.test(cmd)) return { can: "partly", text: "/undo can put back files git sees, not ignored ones (build output, caches, .env)" };
    return { can: "yes", text: "/undo can put the project's files back" };
  }
  approve: Approve = async (req) => {
    const { name, args, preview, reason } = req, w = this.width;
    if (!req.floor && name === "sh" && this.shAllowed(String(args.cmd))) return true;
    if (!req.floor && this.toolRules.has(name)) return true;
    let title = "Permission", body: string[] = [], question = "Allow this?", options: { label: string; hint?: string }[];
    let paint: ((s: string) => string) | undefined, detail: ChoiceDetail | undefined;
    if (name === "exit_plan_mode") {
      title = "Ready to code?"; body = renderMarkdown(String(args.plan ?? preview ?? ""), w - 6); question = "Would you like to proceed?"; detail = { kind: "plan", md: String(args.plan ?? preview ?? "") };
      options = [{ label: "Yes, and accept edits automatically" }, { label: "Yes, and ask before each edit" }, { label: "Yes, after I edit the plan", hint: "opens the plan to change" }, { label: "No, keep planning", hint: "tell it what to change" }];
    } else if (name === "write_file" || name === "edit_file" || name === "apply_patch") {
      const target = name === "apply_patch" ? `${(String(args.patch).match(/^(?:\*\*\* (?:Update|Add|Delete) File:|\+\+\+ )/gm) ?? []).length || "?"} file(s)` : String(args.path);
      title = `${name === "write_file" ? "Write" : name === "apply_patch" ? "Patch" : "Edit"} ${target}`; body = preview ? renderDiff(preview, w - 4, 18).map((l) => l.slice(5)) : [String(args.path)];
      question = "Apply this change?"; if (preview) detail = { kind: "diff", path: name === "apply_patch" ? target : String(args.path), diff: preview };
      options = [{ label: "Yes" }, { label: "Yes, and accept all edits this session", hint: "shift+tab" }, { label: "No, and tell Amness what to do instead", hint: "esc" }];
    } else if (name === "sh" || name === "sh_start") {
      const cmd = String(args.cmd), danger = riskOf(cmd), risk = explainCommand(cmd), undo = risk && this.undoFor(cmd, risk);
      paint = risk?.level === "high" ? yellow : undefined; title = name === "sh_start" ? "Start in the background" : "Run command"; question = "Run this command?";
      body = [bold(cmd), ...(risk ? ["", (risk.level === "high" ? yellow("▲ ") : cyan("● ")) + risk.what, undo!.can === "no" ? red(`✗ ${undo!.text}`) : dim(`↺ ${undo!.text}`)] : [])];
      detail = { kind: "command", cmd, ...(risk && { risk: { what: risk.what, level: risk.level }, undo }) };
      const prefix = shPrefix(String(args.cmd));
      const simple = !danger && !/[;&|<>`$()]/.test(String(args.cmd));
      options = [{ label: "Yes" }, ...(simple ? [{ label: `Yes, and don't ask again for ${bold(prefix)} commands`, hint: "this session" }, { label: `Yes, and always allow ${bold(prefix + " *")} in this project`, hint: "saves a rule" }] : []), { label: "No, and tell Amness what to do instead", hint: "esc" }];
    } else {
      title = name; detail = { kind: "text", text: `${reason ?? "requires approval"}\n${JSON.stringify(args)}` }; body = [reason ?? "requires approval", ...(preview ? ["", preview] : []), "", dim(one(JSON.stringify(args), w - 8))];
      options = [{ label: "Yes" }, { label: `Yes, and don't ask again for ${bold(name)}`, hint: "this session" }, { label: "No, and tell Amness what to do instead", hint: "esc" }];
    }
    this.ensureTimer(); this.notifyAway("Amness needs your approval", `${title}: ${question}`);
    const idx = await new Promise<number | undefined>((res) => { this.overlay = new ChoiceOverlay(title, body, question, options, res, paint, detail); this.render(); });
    this.overlay = null; this.render();
    if (idx === undefined) return "the user declined this action; take a different approach or ask what they want";
    const last = idx === options.length - 1;
    if (last) { const note = await this.askText("What should Amness do instead?"); return note || "the user declined this action"; }
    if (name === "exit_plan_mode" && idx === 2) {                                  // edit the plan first; the tool tells the agent to follow your version
      const plan = String(args.plan ?? preview ?? ""), edited = await this.editLongText("Edit the plan", plan, "Change, reorder, add or delete steps. Amness follows your version.");
      if (edited === undefined) return "the user did not approve the plan yet; ask what they want to change";
      if (edited.trim() && edited.trim() !== plan.trim()) this.planEdit = edited;
      this.setMode("default");
    } else if (name === "exit_plan_mode") this.setMode(idx === 0 ? "acceptEdits" : "default");
    else if (idx === 1 && (name === "write_file" || name === "edit_file" || name === "apply_patch")) this.setMode("acceptEdits");
    else if (idx === 1 && name === "sh") this.shRules.add(shPrefix(String(args.cmd)));
    else if (idx === 2 && name === "sh") {
      this.shRules.add(shPrefix(String(args.cmd)));
      try { Permissions.addProjectRule(this.cwd, "allow", `sh(${shPrefix(String(args.cmd))} *)`); const fp = projectConfigFingerprint(this.cwd), st = loadState(); if (fp && this.persist) { st.hookTrust = { ...(st.hookTrust ?? {}), [this.cwd]: fp }; saveState(st); } this.loadHooks(); this.note(`saved: allow sh(${shPrefix(String(args.cmd))} *)`); } catch { /* the session rule still applies */ }
    }
    else if (idx === 1) this.toolRules.add(name);
    return true;
  };
  private shAllowed(cmd: string) {
    if (/[;&|<>`$()]/.test(cmd) || riskOf(cmd)) return false;
    return [...this.shRules].some((p) => cmd === p || cmd.startsWith(p + " "));
  }

  // ------------------------------------------------------------------ helpers used by commands
  pick<T>(title: string, items: PickItem<T>[], initial = 0, onMove?: (v: T | undefined) => void, preview?: (v: T) => string[]): Promise<T | undefined> {
    return new Promise((res) => { const p = new PickerOverlay(title, items, (v) => { this.overlay = null; this.render(); res(v); }, initial); if (onMove) p.onMove = onMove; if (preview) p.preview = preview; this.overlay = p; this.render(); });
  }
  askText(prompt: string, o: { secret?: boolean; initial?: string } = {}): Promise<string | undefined> {
    return new Promise((res) => { this.overlay = new InputOverlay(prompt, (v) => { this.overlay = null; this.render(); res(v); }, o); this.render(); });
  }
  showText(lines: string[], title?: string) { return new Promise<void>((res) => { this.overlay = new TextOverlay(lines, () => { this.overlay = null; this.render(); res(); }, title); this.render(); }); }
  openPager(lines: string[], title = "transcript", start: "top" | "bottom" = title === "transcript" ? "bottom" : "top") {
    if (this.structured) { void this.showText(lines, title); return; }                 // the full-screen UI and the desktop show these as a scrollable dialog
    this.screen.enterAlt();
    this.pager = new Pager(lines, this.io.output, () => { this.pager = null; this.screen.leaveAlt(); this.render(); }, title, start);
  }
  openTranscript() { this.openPager(transcriptLines(this.session.messages, this.screen.cols - 1)); }
  /** Ctrl+P: every command in a filterable list. Commands that need an argument are typed into the input instead of run. */
  /** ctrl+r: find one of your earlier messages by typing any part of it. */
  async openHistorySearch() {
    if (this.overlay || !this.editor.history.length) return;
    const h = await this.pick("Your earlier messages (type to search)", this.editor.history.map((t) => ({ label: one(t, 100), value: t })));
    if (h !== undefined) { this.editor.setText(h); this.after(); }
  }
  /** ctrl+g: write the message in your own editor ($VISUAL or $EDITOR), then come back with what you saved. */
  editInEditor() {
    this.suspendTerminal(); let out: string | undefined;
    try { out = editExternally(this.editor.text); } finally { this.resumeTerminal(); }
    if (out === undefined) this.note(`could not open ${editorCommand()}: set $VISUAL or $EDITOR to your editor (for example "code --wait")`); else this.editor.setText(out);
    this.after();
  }
  /** Open a file named in a reply in the user's editor, at a line if one was given. A terminal editor takes the screen until it closes. Tests replace `runEditor`. */
  openFile(path: string, line?: number) {
    const abs = resolvePath(this.cwd, path), how = fileOpenCommand(process.env.VISUAL || process.env.EDITOR || "", abs, line ?? 1);
    if (how.terminal) { this.suspendTerminal(); try { this.runEditor(how.cmd, true); } finally { this.resumeTerminal(); } }
    else { this.runEditor(how.cmd, false); this.full?.toast(`opening ${path}${line ? ":" + line : ""}`, "info"); }
    this.render();
  }
  runEditor: (cmd: string, wait: boolean) => void = (cmd, wait) => {
    if (wait) spawnSync(cmd, { stdio: "inherit", shell: true });
    else { try { const p = spawn(cmd, { shell: true, detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); } catch { /* no editor: nothing opens */ } }
  };
  /** Vim-style editing state (used when cfg.vim is on). */
  vim = new Vim();
  /** The earlier message being edited in the input box (/edit): Enter resends it from that point. */
  editing: { turn: number } | undefined;
  /** The plan as the user edited it at approval, handed to the agent once (see CodeAgentOptions.editedPlan). */
  planEdit: string | undefined;

  /** Edit a longer text: the desktop shows an editor (an overlay it draws); the terminal opens $VISUAL / $EDITOR. Undefined when cancelled. */
  editLongText(title: string, text: string, hint = ""): Promise<string | undefined> {
    if (this.remote) return new Promise((res) => { this.overlay = new LongTextOverlay(title, text, (v) => { this.overlay = null; this.render(); res(v); }, hint); this.render(); });
    this.suspendTerminal(); let out: string | undefined;
    try { out = editExternally(text); } finally { this.resumeTerminal(); this.render(); }
    if (out === undefined) this.note(`could not open ${editorCommand()}: set $VISUAL or $EDITOR`);
    return Promise.resolve(out);
  }
  /** Start editing your message `turn` (0-based) in the input box (the terminal); Enter then resends it from there. */
  startEditing(turn: number) {
    const t = this.session.turns[turn]; if (!t || this.running) return;
    this.editing = { turn }; this.editor.setText(t.text); this.render();
  }
  /**
   * Resend your message `turn` (0-based) with new text. The conversation as it was is kept as a branch (/branches); this one goes back to before that
   * message (the files Amness changed after it too, as /rewind does), then the new text runs.
   */
  async editMessage(turn: number, text: string) {
    if (this.running) { this.note("wait for the current turn to finish (or stop it)"); return; }
    if (!this.session.turns[turn] || !text.trim()) return;
    if (this.persist) try { const keep = forkSession(this.session, this.session.turns.length - 1); keep.title = (this.session.title || "(untitled)") + " (before edit)"; this.store.save(keep); } catch { /* not saved: the edit still goes ahead */ }
    await this.rewindTo(turn);
    await this.submitText(text.trim());
  }
  /** Edit the agent's todo list as text ("- [x] done", "- [~] doing", "- [ ] to do"); the agent is told about the new list. */
  async editTodos() {
    const mark = (s: string) => (s === "done" ? "x" : s === "in_progress" ? "~" : " ");
    const text = this.todos.map((t) => `- [${mark(t.status)}] ${t.content}`).join("\n") || "- [ ] ";
    const edited = await this.editLongText("Edit the todo list", text, "One item per line: - [ ] to do, - [~] doing, - [x] done.");
    if (edited === undefined) return;
    const todos = edited.split("\n").map((l) => /^\s*[-*]?\s*\[( |x|X|~)\]\s*(.+?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m && !!m[2].trim())
      .map((m) => ({ content: m[2], status: m[1] === " " ? "pending" : m[1] === "~" ? "in_progress" : "done" }));
    this.todos = todos;
    const note = `[I changed the todo list. Use this list from now on (send it in full with todo_write when you update it):\n${todos.map((t) => `- [${mark(t.status)}] ${t.content}`).join("\n") || "(empty)"}]`;
    if (this.running) this.queued.push({ text: "(todo list edited)", full: note }); else this.pendingContext.push(note);
    this.say(`todo list updated (${todos.length} item${todos.length === 1 ? "" : "s"})`, dim);
    this.render();
  }
  get vimNormal() { return !!this.cfg.vim && this.vim.mode === "normal"; }
  /** Whether the terminal window has focus (focus reporting); undefined until the terminal says. */
  focused: boolean | undefined;
  /** What the last finished turn cost, subagents included (null when the model's price is unknown). */
  lastTurnCost: number | null = null;
  private turnUsage0 = { prompt: 0, completion: 0, calls: 0 } as App["session"]["usage"];
  /** Shows a desktop notification (tests replace it). */
  notifier: (title: string, body: string) => void = (title, body) => notify(this.io.output, title, body);
  /** Notify only while the terminal is known to be in the background, so nothing pops up while you watch. */
  notifyAway(title: string, body: string) { if (this.focused === false && this.cfg.notify !== "off") this.notifier(title, body); }
  /** How ctrl+v reads an image from the clipboard (tests replace it). */
  readClipboard: () => Buffer | undefined = readClipboardImage;
  /** ctrl+v: an image on the clipboard is saved in the project and mentioned, so it goes with the next message. Text pastes still come from the terminal itself. */
  pasteImage() {
    const png = this.readClipboard();
    if (!png) { this.note("no image on the clipboard (text is pasted with your terminal's own paste)"); return this.render(); }
    const rel = savePastedImage(this.cwd, png); this.editor.insert(`@${rel} `); this.after(false);
  }
  /** Give the terminal to another program (an editor) and take it back. */
  private suspendTerminal() { const { input, output } = this.io; this.full?.leave(); output.write(PASTE_OFF + FOCUS_OFF + "\x1b[?25h"); input.off?.("data", this.onData); input.setRawMode?.(false); input.pause?.(); }
  private resumeTerminal() { const { input, output } = this.io; input.setRawMode?.(true); input.resume?.(); input.on("data", this.onData); output.write(PASTE_ON + FOCUS_ON); this.full?.enter(); this.full?.invalidate(); }
  async openPalette() {
    if (this.overlay) return;
    const pick = await this.pick("Commands", this.cmds.map((c) => ({ label: "/" + c.name, value: c, hint: c.help })));
    if (!pick) return;
    if (pick.args) { this.editor.setText(`/${pick.name} `); this.render(); } else await this.runCommand("/" + pick.name);
  }
  async openRewind() {
    if (this.running || !this.session.turns.length) return;
    const idx = await this.pick("Rewind to before…", this.session.turns.map((t, i) => ({ label: `${i + 1}. ${one(t.text, 60)}`, value: i, hint: `${Object.keys(t.snaps).length} file(s) changed` })).reverse());
    if (idx !== undefined) await this.rewindTo(idx);
  }
  async rewindTo(idx: number) {
    const r = await rewindFull(this.session, this.cwd, idx, this.snaps);
    this.pendingEdits.clear(); this.recount(); this.saveSession(); this.rebuildBlocks();
    this.commit(["", `  ${green("↩")} ${dim(`rewound the conversation to before turn ${idx + 1}`)}${r.restored.length || r.removed.length ? dim(` · restored ${r.restored.length} file(s), removed ${r.removed.length}`) : ""}${r.tree ? dim(` · undid shell changes: ${r.tree.restored.length} restored, ${r.tree.removed.length} removed`) : ""}`, ...(r.treeError ? [`  ${yellow("!")} ${dim("could not undo shell changes: " + r.treeError)}`] : []), ...(r.irreversible.length ? [`  ${yellow("!")} ${dim("these commands had effects undo cannot take back:")}`, ...r.irreversible.map((x: string) => `     ${dim(x)}`)] : [])]);
    this.render();
  }
  /** Fork the conversation after turn `idx`. The current conversation is saved as it is; the working tree is put back to how it was at that point. */
  async branchAfter(idx: number) {
    const before = this.session, fork = forkSession(before, idx); this.saveSession();
    let files = ""; if (idx + 1 < before.turns.length) { const r = await rewindFull(structuredClone(before), this.cwd, idx + 1, this.snaps); files = ` · restored ${r.restored.length} file(s), removed ${r.removed.length}${r.tree ? ", undid shell changes" : ""}`; }
    this.session = fork; this.recount(); this.edits = []; this.pendingEdits.clear(); this.saveSession(); this.rebuildBlocks();
    this.commit(["", `  ${green("⑂")} ${dim(`branched after turn ${idx + 1} of "${before.title || "(untitled)"}"${files}`)}`, dim("  the original is kept: /branches switches back (files are not swapped back automatically)")]); this.render();
  }
  /** Switch UI mode live. History is kept in the block store, so nothing is lost either way. */
  switchUi(to: "full" | "inline") {
    if (to === this.ui) return;
    if (this.full) { this.full.leave(); this.full = undefined; } else this.screen.clear();
    this.ui = to; this.screen.height = 0;
    if (to === "full") { this.full = new FullView(this); this.full.enter(); this.rebuildBlocksIfEmpty(); }
    else this.out.push(...welcome({ version: this.version, model: this.cfg.model, provider: this.cfg.provider, cwd: this.cwd, branch: this.branch, notes: this.agent.memory?.list().length ?? 0, verify: this.verify, mode: this.mode, tip: "use /ui full to go back to the full-screen UI" }, this.width), ...(this.session.turns.length ? [dim("  (earlier messages are kept; /ui full shows them)")] : []));
    this.render();
  }
  private rebuildBlocksIfEmpty() { if (!this.blocks.blocks.length && this.session.messages.length) this.blocks.loadMessages(this.session.messages); }
  rebuildBlocks() { this.blocks.loadMessages(this.session.messages); this.full?.invalidate(); }
  async resumeById(id: string) { const s = this.store.load(id); if (!s) return; this.loadSession(s); this.rebuildBlocks(); this.render(); }
  /** skills the model loaded in this conversation, with how many times */
  skillsUsed = new Map<string, number>();
  newConversation() { this.skillsUsed.clear(); this.saveSession(); this.session = newSession(this.cwd, this.cfg.model); this.edits = []; this.trace = []; this.trimmed = 0; this.cacheBreaks = 0; this.lastPrompt = 0; this.todos = []; this.pendingContext = []; this.blocks.clear(); this.full?.invalidate(); this.buildAgent(); }
  loadSession(s: SessionData) { this.saveSession(); this.session = s; this.recount(); this.edits = []; }
  saveSession() { if (this.persist && this.session.turns.length) try { this.session.model = this.cfg.model; this.store.save(this.session); } catch { /* read-only dir */ } }
  saveHistory() { if (!this.persist) return; try { mkdirSync(home(), { recursive: true }); writeFileSync(join(home(), "history.json"), JSON.stringify(this.editor.history.slice(0, 200))); } catch { /* ignore */ } }
  saveConfig() { if (this.persist) saveConfig(this.cfg); }
  /** Put text on the clipboard (OSC 52 plus the platform tool). */
  copyText(text: string) { if (this.remote?.copy) this.remote.copy(text); else if (this.full) this.full.copy(text); else copyToClipboard(this.io.output, text, this.persist); }
  // ---- cache keep-alive: Claude drops a cached prefix after ~5 idle minutes; a tiny re-send every ~4.5 minutes costs a cache read instead of a cold re-read.
  private warmTimer?: ReturnType<typeof setTimeout>; private warmCount = 0; private lastCached = 0;
  stopWarm() { if (this.warmTimer) clearTimeout(this.warmTimer); this.warmTimer = undefined; this.warmCount = 0; }
  private scheduleWarm() {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    if (!this.cfg.keepWarm || this.cfg.provider !== "anthropic" || !this.session.messages.length || this.lastCached <= 0 || this.warmCount >= 3) return;
    this.warmTimer = setTimeout(async () => {
      this.warmTimer = undefined;
      if (this.running || !this.cfg.keepWarm) return;
      try {
        const r = await this.agent.warm(this.session.messages); this.warmCount++;
        this.lastCached = r.cached; this.note(`cache kept warm (${r.prompt ? Math.round((r.cached / r.prompt) * 100) : 0}% of the prompt was cached)`);
        this.scheduleWarm();
      } catch { /* a failed ping is harmless: the next real request just re-reads the prefix */ }
    }, this.opts.keepWarmMs ?? 270_000);
    this.warmTimer.unref?.();
  }
  /** Project hooks run commands on this machine, so a cloned repo's hooks only run after the user approves this exact file. */
  policyLog: string[] = []; hooks!: Hooks; rules!: Permissions; roles: Roles = {}; wired?: Wired; lastRoute = "";
  loadHooks() {
    const fp = projectConfigFingerprint(this.cwd), trusted = !!fp && loadState().hookTrust?.[this.cwd] === fp;
    try { this.hooks = Hooks.load(this.cwd, { trustProject: trusted }); } catch (e) { this.hooks = Hooks.load(this.cwd, { trustProject: false }); this.note(`hooks ignored: ${(e as Error).message}`); }
    try { this.rules = Permissions.load(this.cwd, { trustProject: trusted }); } catch (e) { this.rules = new Permissions({}, this.cwd); this.note(`permission rules ignored: ${(e as Error).message}`); }
    return { fp, trusted };
  }
  plugins: Plugin[] = [];
  private statusAt = 0; private statusLines: string[] = [];
  /** one line per plugin that has a `status` function, cached for a second; a failing plugin shows nothing */
  pluginStatus(): string[] {
    if (Date.now() - this.statusAt < 1000) return this.statusLines; this.statusAt = Date.now();
    this.statusLines = this.plugins.flatMap((p) => { try { const s = p.status?.({ cwd: this.cwd, running: this.running }); return s ? [`${p.name}: ${String(s).slice(0, 60)}`] : []; } catch { return []; } });
    return this.statusLines;
  }
  /** loaded plugins plus the loop strategy chosen with /strategy and the prompt chosen with /prompt */
  activePlugins(): Plugin[] {
    const extra: Plugin[] = []; const s = this.cfg.strategy && STRATEGIES[this.cfg.strategy]; if (s) extra.push(s());
    if (this.cfg.prompt) { try { extra.push(promptPlugin(this.cwd, this.cfg.prompt)); } catch (e) { this.note(`prompt ignored: ${(e as Error).message}`); this.cfg.prompt = undefined; } }
    return extra.length ? [...this.plugins, ...extra] : this.plugins;
  }
  /** Load plugins: yours always, the project's only once you approved exactly these files. */
  async loadPluginsNow() {
    const fp = pluginFingerprint(this.cwd), trusted = !!fp && loadState().pluginTrust?.[this.cwd] === fp;
    const r = await loadPlugins(this.cwd, { trustProject: trusted }); this.plugins = r.plugins; for (const w of r.warnings) this.note(`plugin: ${w}`);
    if (this.cfg.sandboxEngine && this.plugins.some((p) => p.sandbox?.name === this.cfg.sandboxEngine)) applySandboxEngine(this.cfg, (m) => this.note(m));   // a plugin's engine exists only from now on
    return { r, fp };
  }
  async askPluginTrust() {
    const { r, fp } = await this.loadPluginsNow();
    if (!r.untrusted || !fp || !this.persist) return;
    const ok = await this.pick(`This project has ${r.untrusted.count} plugin file${r.untrusted.count === 1 ? "" : "s"} (.amness/plugins). A plugin is code that runs with your permissions and can change what the agent does. Trust this version of the files?\n${describeProjectPlugins(this.cwd).map((l) => "  " + l).join("\n")}\n(a text scan, not a guarantee: read them first)`, [{ label: "Yes, trust this version", value: "y" }, { label: "No, run without them", value: "n" }]);
    if (ok === "y") { const st = loadState(); st.pluginTrust = { ...(st.pluginTrust ?? {}), [this.cwd]: fp }; saveState(st); await this.loadPluginsNow(); }
  }
  /** The first time Amness opens a folder, ask whether you trust it (as Claude Code does): the agent reads, changes and runs what is there, and a stranger's files can carry instructions.
   * A yes is saved in state.json and covers the folders inside it. Without saving (tests, --no-persist) nothing is asked. */
  async trustFolder(): Promise<boolean> {
    if (!this.persist) return true;
    const st = loadState(), here = resolvePath(this.cwd);
    if ((st.trustedDirs ?? []).some((d) => here === d || here.startsWith(d.endsWith(sep) ? d : d + sep))) return true;
    const home = here === resolvePath(homedir());
    const body = [bold(here), "", "Amness will read, change and run files here to do what you ask.", "Files from someone else can contain instructions that make the agent do things you did not intend.",
      ...(home ? ["", yellow("This is your home folder. Open a project folder instead if you can.")] : []), "", dim("Only continue if you wrote these files or trust where they came from. Folders inside it are trusted too."), dim("Project hooks, plugins and permission rules (.amness/) are still asked about separately.")];
    this.notifyAway("Amness needs your approval", "Do you trust the files in this folder?");
    const idx = await new Promise<number | undefined>((res) => { this.overlay = new ChoiceOverlay("New folder", body, "Do you trust the files in this folder?", [{ label: "Yes, I trust this folder" }, { label: this.ui === "remote" ? "No" : "No, exit", hint: "esc" }], res, home ? yellow : undefined); this.render(); });
    this.overlay = null; this.render();
    if (idx !== 0) return false;
    const now = loadState(); now.trustedDirs = [...new Set([...(now.trustedDirs ?? []), here])]; saveState(now);
    return true;
  }
  /** Folders outside this project the file tools may use: allowed for good (state.json, per project, so a cloned repo cannot grant itself access) or for this session. */
  savedDirs: string[] = []; sessionDirs: string[] = [];
  allowedDirs = (): string[] => [...this.savedDirs, ...this.sessionDirs];
  private dirAsks: Promise<unknown> = Promise.resolve();
  /** A file tool wants a path outside the project: ask once per folder. Questions wait for each other (subagents ask too), and a folder allowed meanwhile is not asked about again. */
  askOutside(req: OutsideRequest): Promise<boolean> {
    const ask = this.dirAsks.then(async () => {
      if (this.allowedDirs().some((d) => req.path === d || req.path.startsWith(d.endsWith(sep) ? d : d + sep))) return true;
      const title = "Outside this project", question = `Allow Amness to use files in ${req.dir}?`;
      const body = [`Amness wants to ${req.write ? "change" : "read"} ${bold(req.path)}`, dim(`That is outside ${this.cwd}.`), "", `Allowing gives the file tools access to ${req.dir} and everything in it.`, dim("Edits there still ask first in Ask mode. Remove a folder with /dirs.")];
      const options = [{ label: "Yes, for this session" }, { label: "Yes, and always for this project", hint: "saved" }, { label: "No", hint: "esc" }];
      this.ensureTimer(); this.notifyAway("Amness needs your approval", question);
      const idx = await new Promise<number | undefined>((res) => { this.overlay = new ChoiceOverlay(title, body, question, options, res, yellow); this.render(); });
      this.overlay = null; this.render();
      if (idx !== 0 && idx !== 1) return false;
      this.allowDir(req.dir, idx === 1); return true;
    });
    this.dirAsks = ask.catch(() => {}); return ask;
  }
  /** Let the file tools use `dir` too: for good (saved for this project) or for this session. */
  allowDir(dir: string, always: boolean) {
    if (always && this.persist) { const st = loadState(), list = [...new Set([...(st.dirs?.[this.cwd] ?? []), dir])]; st.dirs = { ...(st.dirs ?? {}), [this.cwd]: list }; saveState(st); this.savedDirs = list; }
    else if (!this.sessionDirs.includes(dir)) this.sessionDirs.push(dir);
  }
  /** Take `dir` off both lists. Returns whether it was on one. */
  removeDir(dir: string): boolean {
    const had = this.allowedDirs().includes(dir); this.sessionDirs = this.sessionDirs.filter((d) => d !== dir);
    if (this.savedDirs.includes(dir)) { const st = loadState(), list = (st.dirs?.[this.cwd] ?? []).filter((d) => d !== dir); st.dirs = { ...(st.dirs ?? {}), [this.cwd]: list }; if (!list.length) delete st.dirs[this.cwd]; saveState(st); this.savedDirs = list; }
    return had;
  }
  private async askHookTrust() {
    const { fp, trusted } = this.loadHooks();
    await this.askPluginTrust();
    if (!fp || trusted || !this.persist) { this.buildAgent(); return; }
    const ok = await this.pick("This project has its own hooks and/or permission rules (.amness/hooks.json, permissions.json). Hooks run commands on your machine and allow-rules skip prompts. Trust them?", [{ label: "Yes, trust this version of the files", value: "y" }, { label: "No, ignore them (deny and ask rules still apply)", value: "n" }]);
    if (ok === "y") { const st = loadState(); st.hookTrust = { ...(st.hookTrust ?? {}), [this.cwd]: fp }; saveState(st); this.loadHooks(); }
    this.buildAgent();
  }
  /** Shell snapshots: before the first command of a turn that may change files, remember the working tree so /undo can put it back. */
  snaps!: Snapshots;
  async beforeShell(cmd: string) {
    const turn = this.session.turns.at(-1); if (!turn) return;
    const irr = irreversibleReason(cmd); turn.shell ??= { cmds: [], irreversible: [] }; turn.shell.cmds.push(cmd.slice(0, 200)); if (irr) turn.shell.irreversible.push(`${cmd.slice(0, 80)} (${irr})`);
    if (!turn.shell.tree) turn.shell.tree = await this.snaps.take();
  }
  /** The harness profile for the current model (guards switched off, limits retuned): .amness/profile.json and ~/.amness/profile.json. */
  profile: { profile: Profile; sources: string[] } = { profile: {}, sources: [] };
/** The loop's settings: the model profile's, then yours from /harness (guards you switch off are added to the profile's). */
  harnessOptions() {
    const p = this.profileOptions(), v = harnessView(this.cfg, { off: p.off, maxSteps: p.maxSteps, stagnationTurns: p.stagnationTurns }), h = this.cfg.harness ?? {};
    const off = v.guards.filter((g) => !g.on).map((g) => g.name) as Guard[];
    return { ...p, ...(off.length && { off }), maxSteps: v.maxSteps, stagnationTurns: v.stagnationTurns, ...(h.contextBudget && { contextBudget: h.contextBudget }), ...(h.governRewrites && { governRewrites: true }) };
  }
  private profileOptions(): { off?: Guard[]; stagnationTurns?: number; maxSteps?: number } {
    try { this.profile = loadProfile(this.cwd, this.cfg.model); } catch (e) { this.profile = { profile: {}, sources: [] }; this.note(`profile ignored: ${(e as Error).message}`); }
    const p = this.profile.profile; return { ...(p.off?.length && { off: p.off }), ...(p.stagnationTurns !== undefined && { stagnationTurns: p.stagnationTurns }), ...(p.maxSteps !== undefined && { maxSteps: p.maxSteps }) };   // thinkingBudget, keepThinking and request travel on the model's card (cli/roles.ts cardFor), so each role model keeps its own
  }
  setCheck(cmd: string | undefined) { this.check = cmd; this.buildAgent(); }
  setVerify(cmd: string | undefined) { this.verify = cmd; if (this.persist) { const st = loadState(); if (cmd) st.verifyByDir[this.cwd] = cmd; else delete st.verifyByDir[this.cwd]; saveState(st); } this.buildAgent(); }
  async ensureLive() { if (!this.live) this.live = await startLive({ title: "Amness" }); return this.live; }
  providerInfo() { return PROVIDERS[this.cfg.provider]; }
  refreshBranch() { execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.cwd }, (e, out) => { const b = e ? undefined : out.trim(); if (b !== this.branch) { this.branch = b; this.schedule(); } }); }
  get memory(): MemoryStore | undefined { return this.agent.memory; }
  get messagesForExport(): Message[] { return this.session.messages; }
  get hasFile() { return (p: string) => existsSync(join(this.cwd, p)); }
}

export function shPrefix(cmd: string): string {
  const t = cmd.trim().split(/\s+/);
  return /^(npm|pnpm|yarn|git|cargo|go|make|docker|kubectl|pip|pip3|python|python3|node|npx|bun|deno|pytest|uv|poetry)$/.test(t[0]) && t[1] && !t[1].startsWith("-") ? `${t[0]} ${t[1]}` : t[0];
}

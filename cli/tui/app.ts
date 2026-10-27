// The chat TUI: one persistent conversation with a live input box, streaming output, permission prompts and slash commands.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Budget, MemoryStore, Tracer, createCodeAgent, Hooks, Permissions, projectConfigFingerprint, openaiEmbedder, riskOf, startLive, type Approve, type Event, type Message, type Model, type PermMode, type Tool } from "../../src/index.ts";
import { PROVIDERS, home, saveConfig, type Config } from "../config.ts";
import { detectVerify } from "../detect.ts";
import { createHash } from "node:crypto";
import { createModel } from "../model.ts";
import { loadState, saveState } from "../state.ts";
import { bold, cyan, dim, gray, green, magenta, red, yellow } from "../ui.ts";
import { BlockStore } from "./blocks.ts";
import { buildCommands, type Cmd } from "./commands.ts";
import { FullView } from "./full.ts";
import { loadCustomCommands } from "./custom.ts";
import { FileIndex, applySuggestion, rankCommands, rankFiles, tokenAtCursor, type Suggestion, type Token } from "./complete.ts";
import { Editor } from "./editor.ts";
import { KeyParser, PASTE_OFF, PASTE_ON, type Key } from "./keys.ts";
import { renderMarkdown, takeCompleteBlocks } from "./markdown.ts";
import { expandMentions, attachedNote } from "./mentions.ts";
import { copyToClipboard } from "./clipboard.ts";
import { ChoiceOverlay, InputOverlay, PickerOverlay, TextOverlay, editKey, type ChoiceDetail, type Overlay, type PickItem } from "./overlays.ts";
import { Pager, transcriptLines } from "./pager.ts";
import { TIPS, at, brandOf, fg, palette, shimmer, sparkline } from "./theme.ts";
import { contextWindow, estimateCost, fmtCost, fmtDuration, fmtTokens } from "./pricing.ts";
import { Screen, type Out } from "./screen.ts";
import { SessionStore, newSession, rewind, snapshot, type SessionData, type Turn } from "./session.ts";
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
  /** "full" = the full-screen UI (alternate screen, mouse, sidebar); "inline" = the classic scrollback UI. */
  ui?: "full" | "inline";
};
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];            // the status line "breathes"
const MODES: PermMode[] = ["default", "acceptEdits", "plan"];
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note";
const one = (s: string, n: number) => { const l = s.replace(/\s+/g, " ").trim(); return cellWidth(l) > n ? clipWidth(l, n - 1) + "…" : l; };

export type TraceStep = { n: number; t0: number; ms: number; prompt: number; completion: number; cached?: number; parallel?: number; tools: { name: string; args: string; ms: number; ok: boolean }[]; notes: string[] };
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
  inflight = new Map<string, { name: string; args: string; t0: number; agent?: string }>();
  pendingEdits = new Map<string, EditEv>();
  streamBuf = ""; msgOpen = false; streamedThisMsg = false;
  todos: { content: string; status: string }[] = [];
  queued: { text: string; full: string }[] = [];
  overlay: Overlay | null = null; pager: Pager | null = null;
  sugg: { items: Suggestion[]; sel: number; token: Token; kind: Token["kind"] } | null = null; suggOff = "";
  private builtin: Cmd[]; private customAt = 0; private customCmds: Cmd[] = [];
  mcp: { cmd: string; tools: Tool[]; close: () => void }[] = [];
  notice = ""; noticeUntil = 0;
  pendingContext: string[] = []; modeNotice = "";
  branch: string | undefined; live: Awaited<ReturnType<typeof startLive>> | undefined;
  private out: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined; private flushT: ReturnType<typeof setTimeout> | undefined; private renderT: ReturnType<typeof setTimeout> | undefined;
  private escAt = 0; private ctrlcAt = 0; frame = 0; private stopped = false;
  /** The structured transcript the full-screen UI draws (kept in both modes so switching never loses history). */
  blocks = new BlockStore(); ui: "full" | "inline"; full?: FullView;
  private opts: AppOptions;
  done: Promise<number>; private resolveDone!: (n: number) => void;

  constructor(o: AppOptions) {
    this.opts = o; this.cfg = o.cfg; this.cwd = o.cwd; this.version = o.version; this.persist = o.persist ?? true;
    this.io = { input: o.input ?? process.stdin, output: o.output ?? (process.stdout as any) };
    this.ui = o.ui ?? "inline"; this.screen = new Screen(this.io.output); this.files = new FileIndex(o.cwd); this.store = new SessionStore(o.cwd);
    if (this.ui === "full") this.full = new FullView(this);
    this.session = newSession(o.cwd, o.cfg.model);
    this.builtin = buildCommands();
    this.done = new Promise((r) => (this.resolveDone = r));
    const st = loadState(); this.verify = st.verifyByDir[o.cwd] ?? (detectVerify(o.cwd) || undefined);
    if (this.persist) try { this.editor.history = JSON.parse(readFileSync(join(home(), "history.json"), "utf8")).slice(0, 200); } catch { /* first run */ }
    this.buildAgent();
  }

  /** Built-in commands plus the user's own (.amness/commands/*.md). Built-ins win name clashes. */
  get cmds(): Cmd[] {
    if (Date.now() - this.customAt > 2000) {
      this.customAt = Date.now();
      this.customCmds = loadCustomCommands([{ dir: join(this.cwd, ".amness", "commands"), scope: "project" }, { dir: join(home(), "commands"), scope: "user" }]);
    }
    const names = new Set(this.builtin.flatMap((c) => [c.name, c.alias ?? ""]));
    return [...this.builtin, ...this.customCmds.filter((c) => !names.has(c.name))];
  }

  // ------------------------------------------------------------------ agent plumbing
  buildAgent() {
    const cacheKey = "amness-" + createHash("sha1").update(this.cwd).digest("hex").slice(0, 12);          // stable per project: better prompt-cache hits
    this.model = (this.opts.makeModel ?? ((c) => createModel(c, undefined, { cacheKey })))(this.cfg);
    this.agent = createCodeAgent({
      model: this.model, cwd: this.cwd, chat: true, permissions: { mode: () => this.mode }, approve: this.approve, inbox: () => this.drainQueue(),
      signal: () => this.ac?.signal, budget: this.budget, verify: this.verify, check: this.check, review: this.cfg.review || undefined, hooks: this.hooks?.count() ? this.hooks : undefined, rules: this.rules, embedder: this.cfg.embeddings && this.cfg.provider !== "anthropic" ? openaiEmbedder({ apiKey: this.cfg.apiKey, baseUrl: this.cfg.baseUrl }) : undefined, onEvent: (e) => this.onEvent(e as Ev), meta: { provider: this.cfg.provider, model: this.cfg.model },
    });
    for (const m of this.mcp) this.agent.registry.add(...m.tools);                       // attached MCP servers survive rebuilds
  }
  get width() { return Math.max(24, this.screen.cols - 1); }
  get ctxPct() { return this.lastPrompt ? Math.min(99, Math.round((this.lastPrompt / contextWindow(this.cfg.model)) * 100)) : null; }
  get cost() { const u = this.session.usage; return fmtCost(estimateCost(this.cfg.model, u.prompt, u.completion, u.cached ?? 0)); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    const { input, output } = this.io;
    input.setRawMode?.(true); input.setEncoding?.("utf8"); input.resume?.();
    output.write(PASTE_ON);
    this.full?.enter();
    input.on("data", this.onData);
    void this.askHookTrust();
    output.on?.("resize", () => { this.full?.invalidate(); this.render(); });
    process.once("exit", this.restore);
    this.files.ensure().catch(() => {});
    this.refreshBranch();
    let resumed: string | undefined;
    if (this.opts.resume) {
      const s = this.opts.resume === "last" ? this.store.latest() : this.store.load(this.opts.resume);
      if (s) { this.session = s; resumed = `"${s.title}" · ${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}`; this.recount(); }
    }
    if (this.full) { if (resumed) this.blocks.loadMessages(this.session.messages); } else this.commit(welcome({ version: this.version, model: this.cfg.model, provider: this.cfg.provider, cwd: this.cwd, branch: this.branch, notes: this.agent.memory?.list().length ?? 0, verify: this.verify, mode: this.mode, resumed, tip: TIPS[Math.floor(Math.random() * TIPS.length)] }, this.width));
    this.setTitle(`Amness · ${basename(this.cwd)}`);
    if (resumed && !this.full) this.replay();
    this.render();
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
    try { if (this.full) this.full.leave(); else { this.screen.clear(); if (this.screen.alt) this.screen.leaveAlt(); } this.io.output.write(PASTE_OFF + "\x1b[?25h"); this.io.input.setRawMode?.(false); this.io.input.pause?.(); this.io.input.off?.("data", this.onData); } catch { /* terminal already gone */ }
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
  commit(lines: string[]) { this.blocks.raw(lines); if (!this.full) this.out.push(...lines); }
  /** Scrollback-only output for things the full-screen UI draws from structured blocks instead. */
  private inlineOnly(lines: string[]) { if (!this.full) this.out.push(...lines); }
  private notify(level: "info" | "warn" | "error" | "ok", text: string, inline: string[]) { if (this.full) this.blocks.notice(level, text); else this.out.push(...inline); }
  private addUser(text: string, note?: string, queued?: boolean) { this.blocks.addUser(text, note, queued); this.inlineOnly(userMessage(text, this.width, note ?? "")); }
  say(text: string | string[], paint: (s: string) => string = (s) => s) {
    for (const t of ([] as string[]).concat(text)) this.commit(["", ...t.split("\n").flatMap((p) => wrapAnsi(paint(p), this.width - 2)).map((l) => "  " + l)]);
  }
  note(text: string, ms = 3000) {
    if (this.full && ms <= 5000) { this.full.toast(text, "info", ms); this.render(); setTimeout(() => this.render(), ms + 40); return; }
    this.notice = text; this.noticeUntil = Date.now() + ms; this.render();
    setTimeout(() => { if (Date.now() >= this.noticeUntil) this.render(); }, ms + 30);               // redraw when it expires so the footer returns to normal
  }

  render = () => {
    if (this.stopped) return;
    if (this.full) { clearTimeout(this.renderT); this.renderT = undefined; return this.full.draw(); }
    if (this.pager) return;
    clearTimeout(this.renderT); this.renderT = undefined;
    const w = this.width, live: string[] = [];
    let cursor: { row: number; col: number } | undefined;
    if (this.streamBuf.trim()) { const r = renderMarkdown(this.streamBuf, w - 2).slice(-6); live.push(...r.map((l, i) => (this.msgOpen || i ? "  " : bold("● ")) + l)); }
    const now = Date.now();
    for (const t of this.inflight.values()) live.push(`${t.agent && t.agent !== "lead" ? dim("  │ ") : ""}${cyan(SPIN[this.frame % SPIN.length])} ${toolCall(t.name, t.args)} ${dim(fmtDuration(now - t.t0))}`);
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
      const r = this.editor.render(w), prompt = this.editor.text.startsWith("!") ? yellow("! ") : this.editor.text.startsWith("#") ? green("# ") : bold(cyan("❯ "));
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
    if (!this.editor.empty) return this.running ? "enter queues your message" : undefined;
    if (this.running) return "type to steer · esc to interrupt";
    const p = this.ctxPct;
    return p !== null && p >= 75 ? (p >= 90 ? "context almost full · /compact" : "context filling up · /compact") : "? for shortcuts · ctrl+p commands";
  }
  setTitle(t: string) { if (this.io.output.isTTY !== false) this.io.output.write(`\x1b]0;${t}\x07`); }
  private suggLines(w: number): string[] {
    const s = this.sugg!, win = 8, top = Math.max(0, Math.min(s.sel - 3, s.items.length - win));
    return s.items.slice(top, top + win).map((it, i) => {
      const on = top + i === s.sel, label = s.kind === "file" ? it.label : it.label.padEnd(12);
      return (on ? cyan("❯ ") + bold(cyan(label)) : "  " + label) + (it.detail ? "  " + (on ? gray(it.detail) : dim(it.detail)) : "");
    }).map((l) => (cellWidth(l) > w ? l.slice(0, w + 12) : l));
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
    if (k.name === "mouse" && k.mouse) { this.full?.mouse(k.mouse); return; }
    if (this.pager) return this.pager.key(k);
    if (this.overlay) { this.overlay.key(k); this.schedule(); return; }
    const ed = this.editor;
    if (this.full) {                                                        // full-screen only keys (scrolling, sidebar, details, theme)
      if (this.full.key(k.name, k.ctrl)) return;
      if (k.ctrl && k.name === "b") { this.full.showSidebar = !this.full.showSidebar; this.full.invalidate(); return this.render(); }
      if (k.ctrl && k.name === "o") { this.full.expandAll = !this.full.expandAll; this.full.toast(this.full.expandAll ? "all tool output expanded" : "tool output collapsed"); return this.render(); }
      if (k.ctrl && k.name === "t") return void this.runCommand("/theme");
      if (k.ctrl && k.name === "l") { this.full.invalidate(); return this.render(); }
    }
    if (k.ctrl && k.name === "c") return this.ctrlC();
    if (k.ctrl && k.name === "d") { if (ed.empty) return this.exit(0); }
    if (k.ctrl && k.name === "o") return this.openTranscript();
    if (k.ctrl && k.name === "p") return void this.openPalette();
    if (k.alt && k.name === "char" && k.text === "m") return void this.runCommand("/model");
    if (k.ctrl && k.name === "l") { this.io.output.write("\x1b[2J\x1b[3J\x1b[H"); this.screen.height = 0; return this.render(); }
    if (k.name === "backtab") return this.cycleMode();
    if (k.name === "escape") return this.escape();
    if (k.name === "tab" && this.sugg) return this.acceptSugg(false);
    if (k.name === "enter" && !k.alt && !k.shift) {
      if (this.sugg && this.sugg.items.length) { const it = this.sugg.items[this.sugg.sel]; if (!(this.sugg.kind === "slash" && ed.text.trim() === it.label)) return this.acceptSugg(true); }
      if (ed.text.slice(0, ed.cursorIndex).endsWith("\\")) { ed.backspace(); ed.newline(); return this.after(); }
      return void this.submit();
    }
    if (k.name === "up" || k.name === "down") {
      if (this.sugg) { const n = this.sugg.items.length; this.sugg.sel = (this.sugg.sel + (k.name === "up" ? n - 1 : 1)) % n; return this.render(); }
      if (!ed.vertical(k.name === "up" ? -1 : 1)) k.name === "up" ? ed.historyPrev() : ed.historyNext();
      return this.after(false);
    }
    if (k.name === "char" && k.text === "?" && ed.empty) return this.openPager(helpLines(this.cmds, this.screen.cols - 1), "help");
    if (this.full && (k.name === "char" || k.name === "paste" || k.name === "backspace")) this.full.clearSelection();
    if (editKey(ed, k)) { this.escAt = 0; return this.after(); }
  }
  private after(suggest = true) { if (suggest) this.updateSugg(); this.render(); }

  private updateSugg() {
    const text = this.editor.text, tok = tokenAtCursor(text, this.editor.cursorIndex), key = tok ? `${tok.kind}:${tok.query}` : "";
    if (!tok || key === this.suggOff) { this.sugg = null; return; }
    this.suggOff = "";
    let items: Suggestion[] = [];
    if (tok.kind === "slash") items = rankCommands(tok.query, this.cmds);
    else {
      if (!this.files.fresh()) void this.files.ensure().then(() => this.updateSugg(), () => {});    // list still loading: fill the popup in once it arrives
      items = rankFiles(tok.query, this.files.files);
    }
    const keep = this.sugg && this.sugg.kind === tok.kind && this.sugg.token.query === tok.query ? this.sugg.sel : 0;
    this.sugg = items.length ? { items, sel: Math.min(keep, items.length - 1), token: tok, kind: tok.kind } : null;
    if (!this.sugg) return;
    this.schedule();
  }
  acceptSuggPublic(fromEnter: boolean) { if (this.sugg) this.acceptSugg(fromEnter); }
  private acceptSugg(fromEnter: boolean) {
    const s = this.sugg!, r = applySuggestion(this.editor.text, s.token, s.items[s.sel]);
    this.editor.setText(r.text, r.cursor); this.sugg = null; this.suggOff = "";
    if (fromEnter && s.kind === "slash" && !this.cmds.find((c) => "/" + c.name === s.items[s.sel].label)?.args) return void this.submit();
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
  cycleMode() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }
  setMode(m: PermMode) {
    if (m === this.mode) return;
    this.mode = m;
    this.modeNotice = m === "plan" ? "[mode: plan mode is ON. You are read-only. Investigate, then present your plan with exit_plan_mode.]" : this.mode === "yolo" ? "" : `[mode: permission mode is now "${m}"; plan mode is off.]`;
    if (m === "default") this.note("default mode: asks before edits and commands"); else this.render();    // other modes announce themselves in the footer label
  }

  // ------------------------------------------------------------------ submitting
  async submit() {
    const text = this.editor.submit(); this.sugg = null; this.suggOff = "";
    if (!text) return this.render();
    this.saveHistory();
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
    if (!cmd) return;
    const { runShell } = await import("../../src/index.ts");
    const callId = "!" + Date.now();
    this.blocks.toolStart(callId, "sh", JSON.stringify({ cmd })); this.inlineOnly(["", toolHeader("sh", JSON.stringify({ cmd }), null).replace("Bash", "Bash!")]); this.render();
    const out = await runShell(cmd, this.cwd, 120_000);
    this.blocks.toolEnd(callId, out); this.inlineOnly(toolResult("sh", "{}", out, this.width));
    this.pendingContext.push(`I ran \`${cmd}\` in my terminal:\n${out.slice(0, 6000)}`);
    this.render();
  }
  remember(note: string) {
    const mem = this.agent.memory;
    if (!note || !mem) return this.note("nothing to remember");
    const e = mem.save({ name: slugify(note.split(/\s+/).slice(0, 6).join(" ")), type: "project", description: one(note, 120), content: note });
    if (this.full) this.blocks.notice("ok", `remembered: ${note}  (saved to ${e.scope} memory as "${e.name}")`); else this.commit(["", `  ${green("✓")} ${dim("remembered:")} ${note}`, `  ${dim(`saved to ${e.scope} memory as "${e.name}"`)}`]);
    this.render();
  }

  async turn(text: string) {
    const { text: expanded, attached } = expandMentions(text, this.cwd);
    const prefix = [this.modeNotice, ...this.pendingContext].filter(Boolean).join("\n\n"); this.modeNotice = ""; this.pendingContext = [];
    const full = prefix ? `${prefix}\n\n${expanded}` : expanded;
    this.addUser(text, attachedNote(attached) || undefined);
    if (!this.session.title) this.session.title = one(text, 60);
    const turn: Turn = { at: this.session.messages.length, text, t: Date.now(), snaps: {} };
    this.session.turns.push(turn);
    this.running = true; this.ac = new AbortController(); this.runStart = Date.now(); this.runTokens = 0; this.todos = []; this.runSeries = []; this.phase = undefined; this.activity = [];
    this.setTitle(`● working · ${basename(this.cwd)}`);
    Object.assign(this.budget, { tokens: 0, calls: 0, t0: Date.now(), maxTokens: this.cfg.maxTokens, maxMs: 60 * 60_000 });
    this.ensureTimer(); this.render();
    let ok = false;
    try {
      const r = await this.agent.chat(this.session.messages, full);
      this.session.messages = r.messages; ok = true;
      if (r.stopped === "budget") this.notify("error", r.text, ["", `  ${red("$")} ${r.text}`]);
      else if (r.stopped === "stuck") this.notify("warn", r.text + "; tell it what to try next", ["", `  ${yellow("!")} ${r.text}; tell it what to try next`]);
      else if (r.stopped === "maxSteps") this.notify("warn", "stopped after the maximum number of steps; send a message to continue", ["", `  ${yellow("!")} stopped after the maximum number of steps; send a message to continue`]);
    } catch (e) {
      this.session.turns.pop();
      const msg = (e as Error).message;
      this.notify("error", one(msg, 400) + (/40[13]|auth|api key|credential/i.test(msg) ? "  (check your key with /provider)" : ""), ["", `  ${red("✗")} ${one(msg, this.width * 2)}`, ...(/40[13]|auth|api key|credential/i.test(msg) ? [`  ${dim("check your key with /provider")}`] : [])]);
    }
    this.flushStream(true); this.blocks.endAssistant(); this.blocks.endThinking();
    const secs = Date.now() - this.runStart;
    if (ok && (secs > 4000 || this.runTokens > 2000)) this.inlineOnly([dim(`  ✻ Worked for ${fmtDuration(secs)} · ${fmtTokens(this.runTokens)} tokens`)]);
    if (this.todos.length && this.todos.some((t) => t.status !== "done")) this.inlineOnly(todoList(this.todos, this.width));
    this.todos = []; this.inflight.clear(); this.running = false; this.ac = undefined; this.thinkBuf = ""; this.scheduleWarm();
    this.setTitle(`${ok ? "✔" : "✗"} Amness · ${basename(this.cwd)}`);
    if (secs > 20_000) this.io.output.write("\x07");                                  // a long turn finished: nudge the user, even if they switched tabs
    this.saveSession(); this.refreshBranch(); this.idleTimer(); this.render();
    if (this.queued.length) { const q = this.queued.splice(0); await this.dispatch(q.map((m) => m.text).join("\n\n")); }
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
        this.session.usage.series = [...(this.session.usage.series ?? []), e.prompt].slice(-200); this.runSeries = [...this.runSeries, e.completion].slice(-40); if (!sub) { this.runTokens = e.tokens; this.lastPrompt = e.prompt; } else this.runTokens += e.completion; break;
      case "text": if (!sub) { this.thinkBuf = ""; this.blocks.endThinking(); this.blocks.streamAssistant(e.delta); this.streamBuf += e.delta; this.streamedThisMsg = true; this.flushStream(false); } break;
      case "assistant": if (!sub) { if (!this.streamedThisMsg || e.streamed === false) { this.blocks.setAssistant(e.text); this.streamBuf = e.text; this.streamedThisMsg = false; } this.blocks.endAssistant(); this.flushStream(true); } break;
      case "toolstart": this.blocks.toolStart(e.id, e.name, e.args, sub); this.inflight.set(e.id, { name: e.name, args: e.args, t0: Date.now(), agent: sub }); this.ensureTimer(); break;
      case "edit": this.pendingEdits.set(e.path, e); this.edits.push(e); snapshot(this.session.turns.at(-1), e.path, e.before); break;
      case "tool": {
        const t = this.inflight.get(e.id ?? ""); this.inflight.delete(e.id ?? ""); this.idleTimer();
        const bad = isFailure(e.result);
        if (!sub) this.stepNow().tools.push({ name: e.name, args: e.args, ms: t ? Date.now() - t.t0 : 0, ok: !bad });
        if (!sub && e.name !== "todo_write") this.activity = [...this.activity, { name: e.name, args: e.args, ms: t ? Date.now() - t.t0 : 0, ok: !bad }].slice(-12);
        let editPath = ""; if ((e.name === "write_file" || e.name === "edit_file") && !bad) { try { editPath = JSON.parse(e.args).path; } catch { /* keep empty */ } }
        const ed = editPath ? this.pendingEdits.get(editPath) : undefined; if (editPath) this.pendingEdits.delete(editPath);
        this.blocks.toolEnd(e.id ?? "", e.result, ed ? { path: ed.path, created: ed.created, added: ed.added, removed: ed.removed, diff: ed.diff } : undefined);
        if (sub) { this.inlineOnly([toolHeader(e.name, e.args, !bad, sub)]); break; }
        if (e.name === "todo_write") break;
        const lines = ["", toolHeader(e.name, e.args, !bad)];
        if (ed) lines.push(`  ${gray("⎿")}  ${dim(editSummary(ed))}`, ...renderDiff(ed.diff, w));
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
      case "hook": this.stepNow().notes.push(`hook ${e.event}${e.blocked ? " blocked" : ""}: ${one(e.detail, 100)}`); if (e.blocked || e.detail !== "added context") this.notify(e.blocked ? "warn" : "info", `hook ${e.event}: ${one(e.detail, 200)}`, [dim(`  ⚙ hook ${e.event}: ${one(e.detail, w - 20)}`)]); break;
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
      case "nudge": this.stepNow().notes.push("nudged: " + one(e.detail, 80)); this.notify("info", "nudged the model to act instead of describing", [dim("  ↻ nudged the model to act instead of describing")]); break;
      case "repair": this.stepNow().notes.push("repaired a tool call: " + one(e.detail, 100)); this.notify("info", `repaired a malformed tool call: ${one(e.detail, 200)}`, [dim(`  ⚒ repaired a malformed tool call: ${one(e.detail, w - 30)}`)]); break;
      case "loop": this.stepNow().notes.push("loop guard: " + one(e.detail, 100)); this.notify("info", "blocked a repeated identical call", [dim("  ∞ blocked a repeated identical call")]); break;
      case "rollover": this.notify("info", "context getting large: continued from a handoff note", [magenta("  ⟳ ") + dim("context getting large: continued from a handoff note")]); break;
      case "budget": this.notify("error", e.detail, ["", `  ${red("$")} ${e.detail}`]); break;
      case "aborted": this.notify("warn", "interrupted. Your progress is kept; send a message to continue.", ["", `  ${yellow("⏹")} ${dim("interrupted. Your progress is kept; send a message to continue.")}`]); break;
      case "steer": case "tools": break;
    }
    this.schedule();
  }

  /** Stream assistant text: complete paragraphs are committed to scrollback immediately; the unfinished tail stays in the live region. */
  flushStream(final: boolean) {
    const w = this.width;
    if (this.full) { if (final) { this.streamBuf = ""; this.msgOpen = false; this.streamedThisMsg = false; } return; }          // the full-screen UI draws the block store
    if (final) { const rest = this.streamBuf; this.streamBuf = ""; if (rest.trim()) { this.commit(assistantBlock(rest, w, !this.msgOpen).map((l, i) => (i === 0 && !this.msgOpen ? ["", l] : [l])).flat()); this.msgOpen = true; } this.msgOpen = false; this.streamedThisMsg = false; return; }
    const { done, rest } = takeCompleteBlocks(this.streamBuf);
    if (done.trim()) { this.commit(assistantBlock(done, w, !this.msgOpen).map((l, i) => (i === 0 && !this.msgOpen ? ["", l] : [l])).flat()); this.msgOpen = true; }
    this.streamBuf = rest;
  }

  // ------------------------------------------------------------------ permission prompts
  approve: Approve = async (req) => {
    const { name, args, preview, reason } = req, w = this.width;
    if (!req.floor && name === "sh" && this.shAllowed(String(args.cmd))) return true;
    if (!req.floor && this.toolRules.has(name)) return true;
    let title = "Permission", body: string[] = [], question = "Allow this?", options: { label: string; hint?: string }[];
    let paint: ((s: string) => string) | undefined, detail: ChoiceDetail | undefined;
    if (name === "exit_plan_mode") {
      title = "Ready to code?"; body = renderMarkdown(String(args.plan ?? preview ?? ""), w - 6); question = "Would you like to proceed?"; detail = { kind: "plan", md: String(args.plan ?? preview ?? "") };
      options = [{ label: "Yes, and accept edits automatically" }, { label: "Yes, and ask before each edit" }, { label: "No, keep planning", hint: "tell it what to change" }];
    } else if (name === "write_file" || name === "edit_file") {
      title = `${name === "write_file" ? "Write" : "Edit"} ${args.path}`; body = preview ? renderDiff(preview, w - 4, 18).map((l) => l.slice(5)) : [String(args.path)];
      question = "Apply this change?"; if (preview) detail = { kind: "diff", path: String(args.path), diff: preview };
      options = [{ label: "Yes" }, { label: "Yes, and accept all edits this session", hint: "shift+tab" }, { label: "No, and tell Amness what to do instead", hint: "esc" }];
    } else if (name === "sh") {
      const danger = riskOf(String(args.cmd)); paint = danger ? yellow : undefined;
      title = "Run command"; body = [bold(String(args.cmd)), ...(danger ? ["", yellow(`⚠ ${danger}`)] : [])]; question = "Run this command?"; detail = { kind: "command", cmd: String(args.cmd), danger: danger || undefined };
      const prefix = shPrefix(String(args.cmd));
      const simple = !danger && !/[;&|<>`$()]/.test(String(args.cmd));
      options = [{ label: "Yes" }, ...(simple ? [{ label: `Yes, and don't ask again for ${bold(prefix)} commands`, hint: "this session" }, { label: `Yes, and always allow ${bold(prefix + " *")} in this project`, hint: "saves a rule" }] : []), { label: "No, and tell Amness what to do instead", hint: "esc" }];
    } else {
      title = name; detail = { kind: "text", text: `${reason ?? "requires approval"}\n${JSON.stringify(args)}` }; body = [reason ?? "requires approval", ...(preview ? ["", preview] : []), "", dim(one(JSON.stringify(args), w - 8))];
      options = [{ label: "Yes" }, { label: `Yes, and don't ask again for ${bold(name)}`, hint: "this session" }, { label: "No, and tell Amness what to do instead", hint: "esc" }];
    }
    this.ensureTimer();
    const idx = await new Promise<number | undefined>((res) => { this.overlay = new ChoiceOverlay(title, body, question, options, res, paint, detail); this.render(); });
    this.overlay = null; this.render();
    if (idx === undefined) return "the user declined this action; take a different approach or ask what they want";
    const last = idx === options.length - 1;
    if (last) { const note = await this.askText("What should Amness do instead?"); return note || "the user declined this action"; }
    if (name === "exit_plan_mode") this.setMode(idx === 0 ? "acceptEdits" : "default");
    else if (idx === 1 && (name === "write_file" || name === "edit_file")) this.setMode("acceptEdits");
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
  pick<T>(title: string, items: PickItem<T>[], initial = 0, onMove?: (v: T | undefined) => void): Promise<T | undefined> {
    return new Promise((res) => { const p = new PickerOverlay(title, items, (v) => { this.overlay = null; this.render(); res(v); }, initial); if (onMove) p.onMove = onMove; this.overlay = p; this.render(); });
  }
  askText(prompt: string, o: { secret?: boolean; initial?: string } = {}): Promise<string | undefined> {
    return new Promise((res) => { this.overlay = new InputOverlay(prompt, (v) => { this.overlay = null; this.render(); res(v); }, o); this.render(); });
  }
  showText(lines: string[], title?: string) { return new Promise<void>((res) => { this.overlay = new TextOverlay(lines, () => { this.overlay = null; this.render(); res(); }, title); this.render(); }); }
  openPager(lines: string[], title = "transcript", start: "top" | "bottom" = title === "transcript" ? "bottom" : "top") {
    if (this.full) { void this.showText(lines, title); return; }                       // the full-screen UI shows these as a scrollable modal
    this.screen.enterAlt();
    this.pager = new Pager(lines, this.io.output, () => { this.pager = null; this.screen.leaveAlt(); this.render(); }, title, start);
  }
  openTranscript() { this.openPager(transcriptLines(this.session.messages, this.screen.cols - 1)); }
  /** Ctrl+P: every command in a filterable list. Commands that need an argument are typed into the input instead of run. */
  async openPalette() {
    if (this.overlay) return;
    const pick = await this.pick("Commands", this.cmds.map((c) => ({ label: "/" + c.name, value: c, hint: c.help })));
    if (!pick) return;
    if (pick.args) { this.editor.setText(`/${pick.name} `); this.render(); } else await this.runCommand("/" + pick.name);
  }
  async openRewind() {
    if (this.running || !this.session.turns.length) return;
    const idx = await this.pick("Rewind to before…", this.session.turns.map((t, i) => ({ label: `${i + 1}. ${one(t.text, 60)}`, value: i, hint: `${Object.keys(t.snaps).length} file(s) changed` })).reverse());
    if (idx !== undefined) this.rewindTo(idx);
  }
  rewindTo(idx: number) {
    const r = rewind(this.session, this.cwd, idx);
    this.pendingEdits.clear(); this.recount(); this.saveSession(); this.rebuildBlocks();
    this.commit(["", `  ${green("↩")} ${dim(`rewound the conversation to before turn ${idx + 1}`)}${r.restored.length || r.removed.length ? dim(` · restored ${r.restored.length} file(s), removed ${r.removed.length}`) : ""}`]);
    this.render();
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
  newConversation() { this.saveSession(); this.session = newSession(this.cwd, this.cfg.model); this.edits = []; this.trace = []; this.trimmed = 0; this.cacheBreaks = 0; this.lastPrompt = 0; this.todos = []; this.pendingContext = []; this.blocks.clear(); this.full?.invalidate(); this.buildAgent(); }
  loadSession(s: SessionData) { this.saveSession(); this.session = s; this.recount(); this.edits = []; }
  saveSession() { if (this.persist && this.session.turns.length) try { this.session.model = this.cfg.model; this.store.save(this.session); } catch { /* read-only dir */ } }
  saveHistory() { if (!this.persist) return; try { mkdirSync(home(), { recursive: true }); writeFileSync(join(home(), "history.json"), JSON.stringify(this.editor.history.slice(0, 200))); } catch { /* ignore */ } }
  saveConfig() { if (this.persist) saveConfig(this.cfg); }
  /** Put text on the clipboard (OSC 52 plus the platform tool). */
  copyText(text: string) { if (this.full) this.full.copy(text); else copyToClipboard(this.io.output, text, this.persist); }
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
  hooks!: Hooks; rules!: Permissions;
  loadHooks() {
    const fp = projectConfigFingerprint(this.cwd), trusted = !!fp && loadState().hookTrust?.[this.cwd] === fp;
    try { this.hooks = Hooks.load(this.cwd, { trustProject: trusted }); } catch (e) { this.hooks = Hooks.load(this.cwd, { trustProject: false }); this.note(`hooks ignored: ${(e as Error).message}`); }
    try { this.rules = Permissions.load(this.cwd, { trustProject: trusted }); } catch (e) { this.rules = new Permissions({}, this.cwd); this.note(`permission rules ignored: ${(e as Error).message}`); }
    return { fp, trusted };
  }
  private async askHookTrust() {
    const { fp, trusted } = this.loadHooks();
    if (!fp || trusted || !this.persist) { this.buildAgent(); return; }
    const ok = await this.pick("This project has its own hooks and/or permission rules (.amness/hooks.json, permissions.json). Hooks run commands on your machine and allow-rules skip prompts. Trust them?", [{ label: "Yes, trust this version of the files", value: "y" }, { label: "No, ignore them (deny and ask rules still apply)", value: "n" }]);
    if (ok === "y") { const st = loadState(); st.hookTrust = { ...(st.hookTrust ?? {}), [this.cwd]: fp }; saveState(st); this.loadHooks(); }
    this.buildAgent();
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

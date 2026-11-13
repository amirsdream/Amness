// The desktop app runs the terminal app's own App, with no terminal (ui "remote"). So every command, the agent loop, approvals, plugins, MCP, hooks, memory,
// budgets and the transcript are one implementation for both front ends; a feature added to App shows up in both.
// This bridge only translates: App state -> events for the window, window actions -> App calls. Dialogs are the App's own overlays, serialised as they open.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { PROVIDERS, cloneConfig, ready, saveConfig, windowFor, type Config } from "../config.ts";
import { SHELL_CHOICES, STRATEGIES, createSessionWorktree, effortsFor, isRepo, removeWorktree, worktreeIsUntouched } from "../../src/index.ts";
import { strip } from "../ui.ts";
import { loadState, saveState } from "../state.ts";
import { App, NOT_TRUSTED } from "../tui/app.ts";
import type { Block } from "../tui/blocks.ts";
import { groupOf } from "../tui/complete.ts";
import { ChoiceOverlay, InputOverlay, LongTextOverlay, PickerOverlay, TextOverlay } from "../tui/overlays.ts";
import { harnessView } from "../tui/harnessinfo.ts";
import { newPanelState, sidebarData, toggleStep, type PanelState } from "../tui/panel.ts";
import { previewLines } from "../tui/session.ts";
import type { SidebarData } from "../tui/sidebar.ts";
import { getTheme } from "../tui/themes.ts";
import { renderLoop } from "../tui/looppanel.ts";
import { setLevel } from "../tui/theme.ts";
import { forceColor } from "../ui.ts";
import { applySettings, settingsView, type SettingChange } from "../tui/settings.ts";
import type { Model } from "../../src/index.ts";

/** A dialog the App opened, as the window shows it. Text in `body`, `lines` and option labels may carry ANSI colours (the same text the terminal shows). */
export type DialogView =
  | { id: number; kind: "choice"; title: string; body: string[]; question: string; options: { label: string; hint?: string }[]; detail?: ChoiceOverlay["detail"] }
  | { id: number; kind: "pick"; title: string; items: { label: string; hint?: string }[]; sel: number; preview: boolean }
  | { id: number; kind: "input"; prompt: string; secret: boolean; initial: string; hint: string }
  | { id: number; kind: "text"; title: string; lines: string[] }
  | { id: number; kind: "longtext"; title: string; text: string; hint: string };

export type StateView = {
  version: string; cwd: string; project: string; provider: string; providerLabel: string; model: string; mode: string; ready: boolean;
  running: boolean; runStart: number; runTokens: number; runSeries: number[]; phase?: { phase: string; step: number; max: number; n?: number };
  thinking: string; queued: string[]; session: { id: string; title: string; turns: number }; vim: boolean; sidebar: SidebarData;
  /** chats that keep working while another one is shown (the shown one is marked current) */ live: LiveView[];
  /** the terminal's own run panel (stages, current step, steps), as coloured lines, so both front ends show the same loop */ loop?: { title: string; right: string; lines: string[]; hits: { line: number; step: number }[] };
};

/** A chat that is alive: the one shown, and the ones that keep working behind it. */
export type LiveView = { id: string; title: string; project: string; provider: string; model: string; running: boolean; waiting: boolean; current: boolean; branch?: string; startedAt: number };

export type ServerEvent =
  | { type: "blocks"; blocks: Block[] } | { type: "block"; block: Block }
  | { type: "state"; state: StateView }
  | { type: "dialog"; dialog: DialogView } | { type: "dialogClose"; id: number }
  | { type: "toast"; level: "info" | "ok" | "warn" | "error"; text: string }
  | { type: "fileChanged"; path: string; diff: string; created: boolean }
  | { type: "copy"; text: string } | { type: "suggestReady" } | { type: "exit" };

/** Input and output that go nowhere: the App never draws in remote mode, but it still owns them. */
const nullIo = () => ({ input: Object.assign(new EventEmitter(), { setRawMode() {}, setEncoding() {}, resume() {}, pause() {} }), output: Object.assign(new EventEmitter(), { write: () => true, columns: 110, rows: 40, isTTY: false }) });

export type BridgeOptions = { cfg: Config; cwd: string; version: string; emit: (e: ServerEvent) => void; persist?: boolean; makeModel?: (c: Config) => Model };

/** A chat kept alive behind the one shown. */
type Live = { app: App; panel: PanelState; cwd: string; worktree?: { dir: string; branch: string; repo: string; base: string }; waited?: boolean; wasRunning?: boolean };

export class DesktopBridge {
  app!: App; cwd: string; panel: PanelState = newPanelState();
  /** Chats that keep working while another one is shown. The shown one is `app`. */
  private live: Live[] = []; private fgWorktree?: Live["worktree"]; private chatN = 0;
  private o: BridgeOptions; private emit: BridgeOptions["emit"];
  private sent = new Map<number, string>(); private sentCount = 0; private timer?: ReturnType<typeof setTimeout>;
  private dialogOf?: object; private dialogId = 0; private switching = false;

  /** The window's colour scheme: the App's renderers use a matching theme for the text they colour. */
  scheme: "dark" | "light" | "retro" = "dark";
  constructor(o: BridgeOptions) { this.o = o; this.emit = o.emit; this.cwd = resolve(o.cwd); setLevel(3); forceColor(true); this.open(this.cwd); }   // the window turns terminal colours into HTML
  get theme() { return getTheme(this.scheme === "light" ? "daylight" : this.scheme === "retro" ? "retro" : this.app.cfg.theme && getTheme(this.app.cfg.theme).dark ? this.app.cfg.theme : "aurora"); }

  /**
   * Run an App for `cwd`. The previous one ends (its conversation is saved), unless it is busy (working, or waiting for your answer):
   * then it keeps going behind the new one (`keep`). `o.cfg` gives the new chat its own copy of the settings, so it can use another provider.
   */
  private open(cwd: string, o: { keep?: boolean; cfg?: Config; resume?: string; sessionsRoot?: string; worktree?: Live["worktree"] } = {}) {
    const back = this.app ? this.cwd : undefined;                                   // a switch the user declines (an untrusted folder) goes back here
    if (this.app) { if (o.keep && this.busy(this.app)) this.live.push({ app: this.app, panel: this.panel, cwd: this.cwd, worktree: this.fgWorktree, wasRunning: this.app.running }); else { this.switching = true; this.app.exit(0); this.switching = false; this.dropWorktreeIfUntouched(this.fgWorktree); } }
    const io = nullIo(), cfg = o.cfg ?? this.o.cfg;
    const app: App = new App({ cfg, cwd, version: this.o.version, ui: "remote", persist: this.o.persist, makeModel: this.o.makeModel, input: io.input, output: io.output as never, sessionsRoot: o.sessionsRoot, ...(o.resume && { resume: o.resume }),
      remote: { changed: () => (this.app === app ? this.changed() : this.behindChanged(app)), toast: (level, text) => this.emit({ type: "toast", level, text: this.app === app ? text : `${this.titleOf(app)}: ${text}` }), copy: (text) => this.emit({ type: "copy", text }) } });
    const onEvent = app.onEvent.bind(app);
    app.onEvent = (e) => { onEvent(e); if (e.kind === "edit" && this.app === app) this.emit({ type: "fileChanged", path: e.path, diff: e.diff, created: e.created }); };
    this.app = app; this.cwd = cwd; this.fgWorktree = o.worktree; this.panel = newPanelState(); this.sent.clear(); this.sentCount = 0; this.dialogOf = undefined;
    void app.done.then((code) => {
      this.live = this.live.filter((l) => l.app !== app);
      if (this.switching || this.app !== app) return;
      if (code === NOT_TRUSTED) this.forgetRecent(cwd);                                 // a folder you said no to is not opened again by itself at the next start
      if (code === NOT_TRUSTED && back) { this.emit({ type: "toast", level: "warn", text: `not opened: you did not trust ${cwd}` }); this.open(back); this.fullSync(); this.changed(); return; }
      this.emit({ type: "exit" });
    });
    void app.start().catch(() => {});
    const startMode = this.o.cfg.desktop?.defaultMode;                              // Preferences: the mode a new window starts in
    if (startMode === "acceptEdits" || startMode === "plan") app.setMode(startMode);
    if (!ready(this.o.cfg)) setTimeout(() => void app.runCommand("/connect"), 300);     // first start without a key: the same connect dialog as the terminal
  }

  // ------------------------------------------------------------------ chats that keep working
  /** Working, or waiting for an answer (an approval): such a chat must not be ended by switching away. */
  private busy(a: App) { return a.running || !!a.overlay || a.queued.length > 0; }
  private titleOf(a: App) { return a.session.title && a.session.title !== "New conversation" ? a.session.title.slice(0, 40) : "a chat in the background"; }
  /** A chat behind the shown one changed: tell the window when it needs you or when it is done, and refresh the chat list. */
  private behindChanged(a: App) {
    const l = this.live.find((x) => x.app === a); if (!l) return;
    if (a.overlay && !l.waited) { l.waited = true; this.emit({ type: "toast", level: "warn", text: `${this.titleOf(a)} is waiting for you (an approval or a question). Open it from the chat list.` }); }
    if (!a.overlay) l.waited = false;
    if (l.wasRunning && !a.running) this.emit({ type: "toast", level: "ok", text: `${this.titleOf(a)} finished${l.worktree ? ` (its changes are on branch ${l.worktree.branch})` : ""}` });
    l.wasRunning = a.running;
    this.changed();
  }
  /** Show a chat that is alive behind this one; the shown one stays alive behind it if it is busy. */
  private bringForward(l: Live) {
    this.live = this.live.filter((x) => x !== l);
    if (this.busy(this.app)) this.live.push({ app: this.app, panel: this.panel, cwd: this.cwd, worktree: this.fgWorktree, wasRunning: this.app.running });
    else { this.switching = true; this.app.exit(0); this.switching = false; this.dropWorktreeIfUntouched(this.fgWorktree); }
    this.app = l.app; this.cwd = l.cwd; this.panel = l.panel; this.fgWorktree = l.worktree; this.sent.clear(); this.sentCount = 0; this.dialogOf = undefined;
    this.hello();
  }
  /** The project a chat belongs to (a chat in a worktree belongs to the repository it came from). */
  private projectOf(cwd: string, wt?: Live["worktree"]) { return wt?.repo ?? cwd; }
  /**
   * Where a new chat should work. When another chat of the same git project is busy, the new one gets its own worktree (Preferences: "parallelWorktree", default on),
   * so two chats never edit the same files. Otherwise it works in the project itself.
   */
  private async placeFor(project: string): Promise<{ cwd: string; worktree?: Live["worktree"]; note?: string }> {
    const others = [{ app: this.app, cwd: this.cwd, worktree: this.fgWorktree }, ...this.live].filter((x) => this.busy(x.app) && this.projectOf(x.cwd, x.worktree) === project);
    if (!others.length || this.o.cfg.desktop?.parallelWorktree === false) return { cwd: project, ...(others.length && { note: "another chat is working in the same folder: both may edit the same files" }) };
    if (!(await isRepo(project))) return { cwd: project, note: "another chat is working in this folder, and it is not a git repository, so both chats share its files" };
    const wt = await createSessionWorktree(project, `chat-${++this.chatN}-${Date.now().toString(36).slice(-4)}`);
    return { cwd: wt.dir, worktree: { dir: wt.dir, branch: wt.branch, repo: wt.repo, base: wt.base }, note: `this chat works on its own copy (branch ${wt.branch}), because another chat is working in ${basename(project)}` };
  }
  /** A worktree a chat made but did not change is removed when the chat ends. */
  private dropWorktreeIfUntouched(wt?: Live["worktree"]) {
    if (!wt) return;
    void worktreeIsUntouched(wt.dir, wt.base).then(async (u) => { if (!u) return; await removeWorktree({ dir: wt.dir, repo: wt.repo }); try { execFileSync("git", ["branch", "-D", wt.branch], { cwd: wt.repo, stdio: "ignore" }); } catch { /* already gone */ } }).catch(() => {});
  }
  /** Every live chat, for the chat list: the shown one first. */
  liveView(): LiveView[] {
    const v = (a: App, current: boolean, wt?: Live["worktree"]): LiveView => ({ id: a.session.id, title: a.session.title, project: basename(wt?.repo ?? a.cwd), provider: a.cfg.provider, model: a.cfg.model, running: a.running, waiting: !!a.overlay, current, ...(wt && { branch: wt.branch }), startedAt: a.runStart });
    return [v(this.app, true, this.fgWorktree), ...this.live.map((l) => v(l.app, false, l.worktree))];
  }

  // ------------------------------------------------------------------ App -> window
  /** The App changed something. Collect changes for a moment, then send what differs. */
  changed() { this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 40); }
  flush() {
    const bs = this.app.blocks.blocks;
    if (bs.length < this.sentCount || (bs.length && !this.sent.has(bs[0].id) && this.sentCount)) this.fullSync();
    else {
      for (const b of bs.slice(Math.max(0, Math.min(this.sentCount, bs.length - 40)))) { const j = JSON.stringify(b); if (this.sent.get(b.id) !== j) { this.sent.set(b.id, j); this.emit({ type: "block", block: b }); } }
      this.sentCount = bs.length;
    }
    this.emit({ type: "state", state: this.state() });
    this.syncDialog();
  }
  fullSync() { const bs = this.app.blocks.blocks; this.sent.clear(); for (const b of bs) this.sent.set(b.id, JSON.stringify(b)); this.sentCount = bs.length; this.emit({ type: "blocks", blocks: bs }); }
  /** Everything a window needs right after it connects. */
  hello() { this.fullSync(); this.emit({ type: "state", state: this.state() }); this.dialogOf = undefined; this.syncDialog(); }

  state(): StateView {
    const a = this.app, now = Date.now(), sidebar = sidebarData(a, this.panel, this.theme, now);
    return {
      version: this.o.version, cwd: a.cwd, project: basename(a.cwd), provider: a.cfg.provider, providerLabel: PROVIDERS[a.cfg.provider]?.label ?? a.cfg.provider, model: a.cfg.model, mode: a.mode, ready: ready(a.cfg),
      running: a.running, runStart: a.runStart, runTokens: a.runTokens, runSeries: a.runSeries, phase: a.phase, thinking: a.running ? a.thinkBuf.slice(-400) : "", queued: a.queued.map((q) => q.text),
      session: { id: a.session.id, title: a.session.title, turns: a.session.turns.length }, vim: false, live: this.liveView(),
      sidebar, loop: sidebar.loop && sidebar.loop.steps.length ? renderLoop(sidebar.loop, this.theme, 44, 60) : undefined,
    };
  }

  private syncDialog() {
    const o = this.app.overlay;
    if (o === this.dialogOf) return;
    if (this.dialogOf) this.emit({ type: "dialogClose", id: this.dialogId });
    this.dialogOf = o ?? undefined; if (!o) return;
    const id = ++this.dialogId;
    let d: DialogView | undefined;
    if (o instanceof ChoiceOverlay) d = { id, kind: "choice", title: o.title, body: o.body, question: o.question, options: o.options.map((x) => ({ label: x.label, hint: x.hint })), detail: o.detail };
    else if (o instanceof PickerOverlay) d = { id, kind: "pick", title: o.title, items: o.items.map((x) => ({ label: x.label, hint: x.hint })), sel: o.sel, preview: !!o.preview };
    else if (o instanceof InputOverlay) d = { id, kind: "input", prompt: o.prompt, secret: o.secret, initial: o.ed.text, hint: o.hint };
    else if (o instanceof TextOverlay) d = { id, kind: "text", title: o.title, lines: o.lines };
    else if (o instanceof LongTextOverlay) d = { id, kind: "longtext", title: o.title, text: o.text, hint: o.hint };
    if (d) this.emit({ type: "dialog", dialog: d });
  }

  // ------------------------------------------------------------------ preferences and settings
  /** The desktop's own preferences (appearance, layout). Saved in the Amness config file, so they survive restarts (the page's own storage does not: its address changes every launch). */
  prefs(): Record<string, unknown> { return { ...(this.app.cfg.desktop ?? {}) }; }
  setPrefs(patch: Record<string, unknown>): Record<string, unknown> {
    const cur: Record<string, unknown> = { ...(this.app.cfg.desktop ?? {}) };
    // names may contain spaces ("fold:Last run", "chats:Previous 30 days"); anything else odd is refused
    for (const [k, v] of Object.entries(patch)) { if (!/^[\w:. -]{1,80}$/.test(k)) continue; if (v === null) delete cur[k]; else cur[k] = v; }
    this.app.cfg.desktop = cur; if (this.o.persist !== false) try { saveConfig(this.app.cfg); } catch { /* read-only home */ }
    return cur;
  }
  /** The agent settings Preferences shows, as they are now. Changing one runs its terminal command (see `command`), so there is one implementation. */
  settings() {
    const c = this.app.cfg, m = c.models ?? {};
    return {
      provider: c.provider, providerLabel: PROVIDERS[c.provider]?.label ?? c.provider, model: c.model, ready: ready(c),
      effort: c.effort ?? "", efforts: c.provider === "anthropic" ? ["low", "medium", "high", "xhigh", "max"] : effortsFor(c.model), maxTokens: c.maxTokens, api: c.api ?? "auto", openai: c.provider !== "anthropic",
      fallback: c.fallback ?? "", models: { explore: m.explore ?? "", compact: m.compact ?? "", review: m.review ?? "", cheap: m.cheap ?? "" }, router: !!c.router, contextWindow: windowFor(c) ?? null,
      sandbox: c.sandbox ?? "off", verify: this.app.verify ?? "", check: this.app.check ?? "", lsp: !!c.lsp, review: !!c.review, approvalReviewer: !!c.approvalReviewer,
      shell: c.shell ?? "auto", shells: ["auto", ...SHELL_CHOICES.filter((x) => x !== "auto")], strategy: c.strategy ?? "off", strategies: ["off", ...Object.keys(STRATEGIES)],
      keepWarm: !!c.keepWarm, plans: !!c.plans, notify: c.notify !== "off", configFile: "~/.amness/config.json",
      harness: harnessView(c, this.app.profile?.profile),
      groups: settingsView(this.app, "desktop"),                                    // the shared list (cli/tui/settings.ts): the same settings as /settings in the terminal
    };
  }
  /** Apply drafts from Preferences, in order, through the same code as /settings and /set; then the fresh settings. */
  async applySettings(changes: SettingChange[]) {
    const results = await applySettings(this.app, changes, (cmd) => this.command(cmd));
    return { results, settings: this.settings() };
  }
  /** Run a terminal command without showing its output in the conversation (Preferences uses this); returns what it said, as plain lines. */
  async command(text: string): Promise<string[]> {
    if (!/^\/[a-z-]+(\s|$)/.test(text)) throw new Error("not a command");
    const before = this.app.blocks.blocks.length;
    await this.app.runCommand(text);
    const added = this.app.blocks.blocks.splice(before); this.app.blocks.version++;
    this.fullSync(); this.changed();
    return added.flatMap((b) => (b.kind === "raw" ? b.lines : b.kind === "notice" ? [b.text] : [])).map((l) => strip(l).trim()).filter(Boolean);
  }

  // ------------------------------------------------------------------ window -> App
  /** The answer to dialog `id`: an option index (choice), an item index (pick), the text (input), or nothing (cancel / close). */
  answer(id: number, value: number | string | null) {
    const o = this.app.overlay; if (!o || id !== this.dialogId) return;
    if (o instanceof ChoiceOverlay) o.done(typeof value === "number" && value >= 0 && value < o.options.length ? value : undefined);
    else if (o instanceof PickerOverlay) o.done(typeof value === "number" && o.items[value] ? o.items[value].value : undefined);
    else if (o instanceof InputOverlay) o.done(typeof value === "string" ? value : undefined);
    else if (o instanceof TextOverlay) o.done();
    else if (o instanceof LongTextOverlay) o.done(typeof value === "string" ? value : undefined);
    this.changed();
  }
  /** Lines describing item `i` of the open picker (a conversation's last messages in /resume). */
  preview(id: number, i: number): string[] { const o = this.app.overlay; return o instanceof PickerOverlay && id === this.dialogId && o.preview && o.items[i] ? o.preview(o.items[i].value) : []; }

  send(text: string) { void this.app.submitText(text.trim()); }
  stop() { this.app.interrupt(); }
  setMode(m: "default" | "acceptEdits" | "plan" | "yolo") { this.app.setMode(m); this.changed(); }
  setScheme(s: "dark" | "light" | "retro") { this.scheme = s; this.changed(); }
  toggleStep(n: number) { toggleStep(this.panel, n); this.changed(); }
  commands() { return this.app.cmds.map((c) => ({ name: c.name, alias: c.alias, help: c.help, args: c.args, group: groupOf(c.name), live: !!c.live })); }
  suggest(text: string, cursor: number) { return this.app.suggestionsFor(text, cursor, () => this.emit({ type: "suggestReady" })); }

  sessions(q = "") {
    const n = q.trim().toLowerCase(), alive = new Map(this.liveView().map((l) => [l.id, l]));
    return this.app.store.list().filter((s) => !n || s.title.toLowerCase().includes(n)).map((s) => ({ ...s, current: s.id === this.app.session.id, running: !!alive.get(s.id)?.running, waiting: !!alive.get(s.id)?.waiting, live: alive.has(s.id) }));
  }
  sessionPreview(id: string) { const s = this.app.store.load(id); return s ? previewLines(s, 8) : []; }
  /** Open a conversation. One that is alive behind this one comes forward; a busy chat keeps working behind the one you open. */
  async resume(id: string) {
    if (id === this.app.session.id) return;
    const l = this.live.find((x) => x.app.session.id === id); if (l) return this.bringForward(l);
    if (!this.busy(this.app)) { await this.app.resumeById(id); this.fullSync(); this.changed(); return; }
    await this.spawnChat(id);
  }
  /** A new conversation. When this one is busy, it keeps working behind the new one. */
  async newConversation() {
    if (!this.busy(this.app)) { this.app.newConversation(); this.fullSync(); this.changed(); return; }
    await this.spawnChat();
  }
  /** A new live chat next to a busy one: its own settings copy (so it can use another provider), its own worktree when they share a git project. */
  private async spawnChat(resume?: string) {
    const project = this.projectOf(this.cwd, this.fgWorktree), place = await this.placeFor(project);
    this.open(place.cwd, { keep: true, cfg: cloneConfig(this.app.cfg), resume, sessionsRoot: project, worktree: place.worktree });
    this.hello(); if (place.note) this.emit({ type: "toast", level: "info", text: place.note });
  }
  /** Which of your turns a message bubble is: your messages and the session's turns, matched in order by their text (messages sent while Amness worked are not turns). */
  turnOfBlock(blockId: number): number | undefined {
    const turns = this.app.session.turns; let t = 0;
    for (const b of this.app.blocks.blocks) {
      if (b.kind !== "user" || b.queued) continue;
      if (t < turns.length && turns[t].text.trim() === b.text.trim()) { if (b.id === blockId) return t; t++; }
      else if (b.id === blockId) return undefined;
    }
    return undefined;
  }
  /** Edit your message (by its bubble) and resend it from there; the old version is kept as a branch. */
  async editMessage(blockId: number, text: string) {
    const t = this.turnOfBlock(blockId); if (t === undefined) throw new Error("this message cannot be edited (it was sent while Amness was working)");
    await this.app.editMessage(t, text); this.fullSync(); this.changed();
  }
  turns() { return this.app.session.turns.map((t, i) => ({ index: i, text: t.text.replace(/\s+/g, " ").slice(0, 120), files: Object.keys(t.snaps).length })); }
  async rewind(idx: number) { if (this.app.running) throw new Error("wait for the current turn to finish"); await this.app.rewindTo(idx); this.fullSync(); this.changed(); }

  openProject(dir: string) {
    const abs = resolve(dir); if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${dir}`);
    if (this.o.persist !== false) { const st = loadState() as ReturnType<typeof loadState> & { recentProjects?: string[] }; st.recentProjects = [abs, ...(st.recentProjects ?? []).filter((p) => p !== abs)].slice(0, 12); saveState(st); }
    this.open(abs, { keep: true, cfg: this.busy(this.app) ? cloneConfig(this.app.cfg) : undefined }); this.hello();
  }
  private forgetRecent(dir: string) {
    if (this.o.persist === false) return;
    const st = loadState() as ReturnType<typeof loadState> & { recentProjects?: string[] }; if (!st.recentProjects?.includes(dir)) return;
    st.recentProjects = st.recentProjects.filter((p) => p !== dir); saveState(st);
  }
  recentProjects(): string[] { return ((loadState() as { recentProjects?: string[] }).recentProjects ?? []).filter((p) => existsSync(p)); }

  async fileList(): Promise<string[]> { await this.app.files.ensure(0); return this.app.files.files; }
  /** A project file's text for the file view. Paths outside the project, binary files and very large files are refused. */
  readFile(rel: string): { path: string; text: string; size: number } {
    const root = resolve(this.app.cwd), abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error("outside the project");
    const st = statSync(abs); if (!st.isFile()) throw new Error("not a file");
    if (st.size > 2_000_000) throw new Error(`too large to show (${Math.round(st.size / 1024)} KB)`);
    const buf = readFileSync(abs); if (buf.subarray(0, 8000).includes(0)) throw new Error("binary file");
    return { path: rel, text: buf.toString("utf8"), size: st.size };
  }
  close() { this.switching = true; for (const l of this.live.splice(0)) l.app.exit(0); this.app.exit(0); }
}

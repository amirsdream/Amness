// The sessions of `amness serve`'s public API (/v1): each one is the terminal app's own App (ui "remote"), so commands, approvals,
// plugins, MCP, hooks, memory and the transcript behave exactly as in the terminal and the desktop app.
// A session is identified by the App's conversation id; its transcript items are the App's blocks; a pending approval or question is the App's overlay.
import { existsSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { cloneConfig, PROVIDERS, ready, type Config } from "../config.ts";
import { resolveConfig } from "../roles.ts";
import { App } from "../tui/app.ts";
import type { Block } from "../tui/blocks.ts";
import { strip } from "../ui.ts";
import { answerOverlay, dialogView, nullIo, type DialogView } from "../desktop/bridge.ts";
import type { Model } from "../../src/index.ts";

export type Mode = "default" | "acceptEdits" | "plan" | "yolo";
export const MODES: Mode[] = ["default", "acceptEdits", "plan", "yolo"];

/** What a client sees of a session. */
export type SessionView = {
  id: string; title: string; cwd: string; project: string; provider: string; model: string; mode: Mode; ready: boolean;
  status: "idle" | "running" | "waiting"; turns: number; queued: number; createdAt: number;
  usage: { tokens: number; cost?: number };
  /** the approval or question the session waits for (answer it with POST …/dialog) */
  dialog?: DialogView; lastAnswer?: string;
};
export type SessionEvent =
  | { type: "item"; session: string; item: Block }
  | { type: "status"; session: string; status: SessionView["status"]; title: string }
  | { type: "dialog"; session: string; dialog: DialogView } | { type: "dialogClose"; session: string; id: number }
  | { type: "turn.completed"; session: string; text: string; status: "done" | "interrupted" }
  | { type: "toast"; session: string; level: string; text: string }
  | { type: "closed"; session: string };

type Live = {
  app: App; createdAt: number; dialogId: number; dialogOf?: object; dialog?: DialogView;
  sent: Map<number, string>; timer?: ReturnType<typeof setTimeout>; wasBusy: boolean; lastAnswer?: string; status: SessionView["status"];
  waiters: Set<() => void>;
};

export type SessionsOptions = { cfg: Config; version: string; persist?: boolean; makeModel?: (c: Config) => Model; roots: string[]; defaultCwd: string; max?: number };

export class ApiSessions {
  private live = new Map<string, Live>(); private subs = new Set<(e: SessionEvent) => void>(); private o: SessionsOptions;
  constructor(o: SessionsOptions) { this.o = { ...o, roots: o.roots.map((r) => resolve(r)) }; }

  /** Every event of every session (the /v1/events stream); returns the unsubscribe function. */
  subscribe(f: (e: SessionEvent) => void) { this.subs.add(f); return () => void this.subs.delete(f); }
  private emit(e: SessionEvent) { for (const f of this.subs) { try { f(e); } catch { /* a broken client must not stop the others */ } } }

  /** Only folders under the roots `amness serve` was started with (default: the folder it started in). */
  folder(dir?: string): string {
    const abs = resolve(this.o.defaultCwd, dir ?? ".");
    if (!this.o.roots.some((r) => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep))) throw Object.assign(new Error(`${abs} is outside the folders this server may use (${this.o.roots.join(", ")}); start it with --root`), { status: 403 });
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw Object.assign(new Error(`not a folder: ${abs}`), { status: 404 });
    return abs;
  }

  /** Start a session (a new conversation, or `resume` a saved one) in `cwd`, optionally with another model (`model`: an id, provider:model or server:<name>) and mode. */
  async create(b: { cwd?: string; resume?: string; model?: string; mode?: Mode; title?: string } = {}): Promise<SessionView> {
    if (this.live.size >= (this.o.max ?? 16)) throw Object.assign(new Error(`too many open sessions (${this.o.max ?? 16}); close one first`), { status: 429 });
    const cwd = this.folder(b.cwd);
    let cfg = cloneConfig(this.o.cfg);
    if (b.model) cfg = resolveConfig(b.model, cfg).config;
    if (b.mode && !MODES.includes(b.mode)) throw Object.assign(new Error(`mode is one of ${MODES.join(", ")}`), { status: 400 });
    const io = nullIo(); let l!: Live;
    const app: App = new App({ cfg, cwd, version: this.o.version, ui: "remote", persist: this.o.persist, makeModel: this.o.makeModel, input: io.input, output: io.output as never, ...(b.resume && { resume: b.resume }),
      remote: { changed: () => this.changed(l), toast: (level, text) => this.emit({ type: "toast", session: app.session.id, level, text }), copy: () => {} } });
    l = { app, createdAt: Date.now(), dialogId: 0, sent: new Map(), wasBusy: false, status: "idle", waiters: new Set() };
    void app.start().catch(() => {});
    if (b.mode) app.setMode(b.mode);
    const sid = () => app.session.id;
    this.live.set(sid(), l);
    void app.done.then(() => { const id = [...this.live].find(([, x]) => x === l)?.[0]; if (id) { this.live.delete(id); this.emit({ type: "closed", session: id }); } for (const w of l.waiters) w(); });
    await new Promise((r) => setTimeout(r, 30));                                                 // let the App settle (a resumed session's id, the trust question)
    if (sid() !== [...this.live].find(([, x]) => x === l)?.[0]) { for (const [k, x] of this.live) if (x === l) this.live.delete(k); this.live.set(sid(), l); }
    if (b.title) app.session.title = b.title.slice(0, 120);
    return this.view(sid());
  }

  private get(id: string): Live { const l = this.live.get(id); if (!l) throw Object.assign(new Error(`no open session ${id} (GET /v1/sessions lists them; POST /v1/sessions with resume opens a saved one)`), { status: 404 }); return l; }
  private statusOf(a: App): SessionView["status"] { return a.overlay ? "waiting" : a.running || a.queued.length ? "running" : "idle"; }
  private lastText(a: App) { const b = [...a.blocks.blocks].reverse().find((x) => x.kind === "assistant") as Extract<Block, { kind: "assistant" }> | undefined; return b?.text ?? ""; }

  view(id: string): SessionView {
    const l = this.get(id), a = l.app;
    return {
      id, title: a.session.title, cwd: a.cwd, project: basename(a.cwd), provider: a.cfg.provider, model: a.cfg.model, mode: a.mode as Mode, ready: ready(a.cfg),
      status: this.statusOf(a), turns: a.session.turns.length, queued: a.queued.length, createdAt: l.createdAt,
      usage: { tokens: a.budget?.tokens ?? 0 }, ...(l.dialog && { dialog: l.dialog }), ...(l.lastAnswer !== undefined && { lastAnswer: l.lastAnswer }),
    };
  }
  /** Open sessions, plus (with `saved`) the conversations saved in a folder. */
  list(o: { saved?: string } = {}) {
    const open = [...this.live.keys()].map((id) => this.view(id));
    if (o.saved === undefined) return { open };
    const cwd = this.folder(o.saved || undefined), any = [...this.live.values()][0]?.app;
    const store = any?.store; const saved = store && any.cwd === cwd ? store.list() : undefined;
    return { open, saved: saved ?? [] };
  }
  items(id: string, since = 0): Block[] { return this.get(id).app.blocks.blocks.filter((b) => b.id > since); }

  /** Send a message (or a slash command, `!shell`, `#note`) as if typed. With `wait`, resolve when the turn ends, a dialog opens, or `timeoutMs` passes. */
  async send(id: string, text: string, o: { wait?: boolean; timeoutMs?: number } = {}) {
    const l = this.get(id); if (!text.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    if (!ready(l.app.cfg)) throw Object.assign(new Error(`no API key for ${PROVIDERS[l.app.cfg.provider]?.label ?? l.app.cfg.provider} on the server`), { status: 409 });
    const before = l.app.session.turns.length;
    void l.app.submitText(text.trim());
    if (!o.wait) return { accepted: true, session: this.view(id) };
    await new Promise<void>((done) => {
      const t = setTimeout(finish, Math.min(o.timeoutMs ?? 600_000, 3_600_000)); t.unref?.();
      function finish() { clearTimeout(t); l.waiters.delete(check); done(); }
      const check = () => { const a = l.app; if (a.overlay || (!a.running && !a.queued.length && (a.session.turns.length > before || /^[/!#]/.test(text.trim())))) finish(); };
      l.waiters.add(check); setTimeout(check, 60);
    });
    const v = this.view(id);
    return { accepted: true, session: v, ...(v.status === "idle" ? { text: this.lastText(l.app) } : {}) };
  }
  interrupt(id: string) { this.get(id).app.interrupt(); return this.view(id); }
  setMode(id: string, mode: Mode) { if (!MODES.includes(mode)) throw Object.assign(new Error(`mode is one of ${MODES.join(", ")}`), { status: 400 }); this.get(id).app.setMode(mode); this.changed(this.get(id)); return this.view(id); }
  /** Answer the open dialog. `value`: an option or item index, the text of an input, or null to cancel. */
  answer(id: string, dialogId: number, value: number | string | null) {
    const l = this.get(id), o = l.app.overlay;
    if (!o || dialogId !== l.dialogId) throw Object.assign(new Error(`dialog ${dialogId} is not open (the open one: ${l.dialog?.id ?? "none"})`), { status: 409 });
    answerOverlay(o, value); this.changed(l); return { ok: true };
  }
  /** Run a slash command and return what it printed, as plain lines (it is not added to the transcript). */
  async command(id: string, text: string): Promise<string[]> {
    if (!/^\/[a-z-]+(\s|$)/.test(text)) throw Object.assign(new Error("not a command (it starts with /)"), { status: 400 });
    const a = this.get(id).app, before = a.blocks.blocks.length;
    await a.runCommand(text);
    const added = a.blocks.blocks.splice(before); a.blocks.version++;
    return added.flatMap((b) => (b.kind === "raw" ? b.lines : b.kind === "notice" ? [b.text] : [])).map((x) => strip(x).replace(/\s+$/, "")).filter((x) => x.trim());
  }
  close(id: string) { const l = this.get(id); l.app.exit(0); this.live.delete(id); this.emit({ type: "closed", session: id }); return { ok: true }; }
  closeAll() { for (const l of this.live.values()) l.app.exit(0); this.live.clear(); }
  get size() { return this.live.size; }

  /** The App changed: send new or changed items, the status, the dialog; tell waiters; announce a finished turn. */
  private changed(l: Live) { l.timer ??= setTimeout(() => { l.timer = undefined; this.flush(l); }, 40); }
  private flush(l: Live) {
    const a = l.app, id = a.session.id;
    for (const b of a.blocks.blocks.slice(-60)) { const j = JSON.stringify(b); if (l.sent.get(b.id) !== j) { l.sent.set(b.id, j); this.emit({ type: "item", session: id, item: b }); } }
    const o = a.overlay ?? undefined;
    if (o !== l.dialogOf) {
      if (l.dialog) this.emit({ type: "dialogClose", session: id, id: l.dialog.id });
      l.dialogOf = o; l.dialog = o ? dialogView(o, ++l.dialogId) : undefined;
      if (l.dialog) this.emit({ type: "dialog", session: id, dialog: l.dialog });
    }
    const st = this.statusOf(a);
    if (st !== l.status) { l.status = st; this.emit({ type: "status", session: id, status: st, title: a.session.title }); }
    const busy = a.running || a.queued.length > 0;
    if (l.wasBusy && !busy) { l.lastAnswer = this.lastText(a); this.emit({ type: "turn.completed", session: id, text: l.lastAnswer, status: a.ac?.signal.aborted ? "interrupted" : "done" }); }
    l.wasBusy = busy;
    for (const w of [...l.waiters]) w();
  }
}

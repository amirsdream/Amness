// The full-screen UI: header, scrollable transcript, sidebar, input panel, modals, toasts and mouse handling, drawn on a cell canvas.
import { copyToClipboard } from "./clipboard.ts";
import { menuRows } from "./complete.ts";
import { capNote } from "./looppanel.ts";
import { openUrl, openableUrl } from "./openurl.ts";
import { basename } from "node:path";
import type { App } from "./app.ts";
import { A, mix, type Cell } from "./ansi.ts";
import { brandOfModel } from "./brand.ts";
import { BORDERS, Canvas } from "./canvas.ts";
import { isQuiet, renderBlock, renderGroup, type Hit, type RenderCtx, type Rendered } from "./cards.ts";
import type { Block } from "./blocks.ts";
import type { MouseEv } from "./keys.ts";
import { MOUSE_OFF, MOUSE_ON, type Key } from "./keys.ts";
import { findRows, type FindHit } from "./find.ts";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { drawModal, type ModalHit } from "./modal.ts";
import { ChoiceOverlay, InputOverlay, PickerOverlay, TextOverlay } from "./overlays.ts";
import { estimateCost, fmtDuration, fmtTokens } from "./pricing.ts";
import { BOLD, F, ITAL, chip, fit, split } from "./rich.ts";
import { renderSidebar } from "./sidebar.ts";
import { newPanelState, sidebarData, toggleStep, toolVerb } from "./panel.ts";
export { toolVerb } from "./panel.ts";
import { cellWidth, clipWidth } from "./text.ts";
import { getTheme, type Theme } from "./themes.ts";
import { level as colorLevel, TIPS } from "./theme.ts";
import { LOGO_ART } from "./brand.ts";
import { argSummary, toolLabel } from "./view.ts";

type Region = { x: number; y: number; w: number; h: number; click?: () => void; kind: string };
type Toast = { text: string; kind: "info" | "ok" | "warn" | "error"; until: number };
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", BARS = "▁▂▃▄▅▆▇█";
export const MODE_LABEL: Record<string, string> = { default: "ask", acceptEdits: "auto-edit", plan: "plan", yolo: "yolo" };

export class FullView {
  app: App;
  canvas: Canvas;
  scroll = 0;                  // rows scrolled up from the bottom (0 = following)
  unseen = 0;                  // new rows that arrived while scrolled up
  showSidebar = true;
  expandAll = false;
  diffMode: "auto" | "stacked" | "split" = "auto";
  mouseOn = process.env.AMNESS_NO_MOUSE !== "1";
  toasts: Toast[] = [];
  private cache = new Map<number, { key: string; r: Rendered }>();
  private regions: Region[] = [];
  private prevTotal = 0;
  private viewTop = 0; private viewH = 0; private viewX = 0; private viewW = 0; private total = 0;
  private items: { b: Block; r: Rendered; start: number; group?: boolean }[] = [];
  /** Groups of quiet tool calls (reads, searches) the user has opened, by the id of the first call. */
  private groupOpen = new Set<number>();
  private sel?: { ax: number; ay: number; hx: number; hy: number; done: boolean; /** "lines" flows through the transcript; "block" is a rectangle (sidebar, modals, anywhere else) */ mode: "lines" | "block" };
  private down?: { x: number; y: number; moved: boolean; mode: "lines" | "block" };
  private lastClick = { t: 0, x: -1, y: -1, n: 0 };
  private sideX = 1e9; private mainW = 80; private toastBase = 20;
  private lastWheel = 0;
  private forceFull = true;
  /** ctrl+f: the text being searched, its matches (rows of the whole transcript), which one is current, and where the view was before (esc goes back). */
  find?: { q: string; hits: FindHit[]; cur: number; back: number; jump: boolean };
  private fileSeen = new Map<string, boolean>();
  private tipIdx = Math.floor(Math.random() * TIPS.length);

  constructor(app: App) {
    this.app = app;
    this.canvas = new Canvas(app.io.output.columns || 80, app.io.output.rows || 24);
  }
  get theme(): Theme { return getTheme(this.app.cfg.theme); }

  // ------------------------------------------------------------------ terminal modes
  enter() {
    const o = this.app.io.output;
    o.write("\x1b[?1049h\x1b[2J\x1b[H" + (this.mouseOn ? MOUSE_ON : ""));
    this.forceFull = true;
  }
  leave() { this.app.io.output.write(MOUSE_OFF + "\x1b[?25h\x1b[?1049l"); }
  setMouse(on: boolean) { this.mouseOn = on; this.app.io.output.write(on ? MOUSE_ON : MOUSE_OFF); this.toast(on ? "mouse on (drag to select, wheel to scroll)" : "mouse off: native selection restored", "info"); }
  toast(text: string, kind: Toast["kind"] = "info", ms = 2600) { this.toasts.push({ text, kind, until: Date.now() + ms }); this.toasts = this.toasts.slice(-3); }
  invalidate() { this.forceFull = true; this.cache.clear(); this.fileSeen.clear(); }

  // ------------------------------------------------------------------ frame
  draw() {
    const app = this.app, o = app.io.output, W = o.columns || 80, H = o.rows || 24, t = this.theme;
    if (this.canvas.w !== W || this.canvas.h !== H) { this.canvas = new Canvas(W, H, t.bg); this.forceFull = true; }
    const c = this.canvas; c.defaultBg = t.bg; c.level = colorLevel; c.clear(t.bg); c.cursor = null; this.regions = [];
    const now = Date.now(); this.toasts = this.toasts.filter((x) => x.until > now);

    const sbW = this.showSidebar && W >= 104 ? Math.max(30, Math.min(40, Math.floor(W * 0.27))) : 0, mainW = W - sbW;
    const edRows = this.editorRows(mainW - 8), inputH = edRows + 2, footerY = H - 1, inputY = footerY - inputH;
    const status = app.running || app.queued.length ? 1 + Math.min(2, app.queued.length) : 0, statusY = inputY - status;
    const trY = 1, trH = Math.max(1, statusY - trY);

    this.drawHeader(c, t, W);
    this.drawTranscript(c, t, 0, trY, mainW, trH, now);
    this.sideX = sbW ? mainW : 1e9; this.mainW = mainW; this.toastBase = statusY;
    if (sbW) this.drawSidebar(c, t, mainW, trY, sbW, H - 1 - trY);
    if (status) this.drawStatus(c, t, 1, statusY, mainW - 2, now);
    this.drawInput(c, t, 1, inputY, mainW - 2, inputH);
    this.drawSuggestions(c, t, 1, inputY, mainW - 2);
    this.drawFooter(c, t, W, footerY, now);
    let modal;
    if (app.overlay) modal = drawModal(c, t, app.overlay, app.frame);
    if (modal) { for (const h of modal.hits) this.regions.push({ x: h.x, y: h.y, w: h.w, h: h.h, kind: "modal", click: () => this.modalClick(h) }); if (modal.cursor) c.cursor = modal.cursor; }
    this.drawToasts(c, t, W);
    this.drawSelection(c, t);

    const seq = c.flush(this.forceFull); this.forceFull = false;
    o.write("\x1b[?2026h\x1b[?25l" + seq + (c.cursor ? `\x1b[${c.cursor.y + 1};${c.cursor.x + 1}H\x1b[?25h` : "") + "\x1b[?2026l");
  }

  // ------------------------------------------------------------------ header
  private drawHeader(c: Canvas, t: Theme, W: number) {
    const app = this.app, brand = brandOfModel(app.cfg.model, app.cfg.provider, t), bg = t.surface;
    const mode = app.mode, modeCol = mode === "yolo" ? t.err : mode === "plan" ? t.info : mode === "acceptEdits" ? t.ok : t.accent;
    c.fill(0, 0, W, 1, bg);
    const logo = gradientText("✻ Amness", t.gradient), proj = BOLD(F(t.text, basename(app.cwd))), br = app.branch ? F(t.dim, "  ⎇ " + app.branch) : "";
    const left = " " + logo + F(t.border, "  │  ") + proj + br;
    const modelChip = chip(`${F(brand.color, brand.icon)} ${app.cfg.model}`, t.text, t.surface2), modeChip = chip(MODE_LABEL[mode] ?? mode, t.onAccent, modeCol, true), sideChip = chip(this.showSidebar ? "▥" : "▤", t.dim, t.surface2);
    const right = modelChip + " " + modeChip + " " + sideChip + " ";
    const title = app.session.title ? F(t.faint, ITAL(clipWidth(app.session.title, Math.max(0, W - cellWidth(left) - cellWidth(right) - 6)))) : "";
    const mid = W - cellWidth(left) - cellWidth(right);
    c.ansi(0, 0, fit(left + (mid > 12 && title ? "  " + F(t.border, "·") + " " + title : ""), W - cellWidth(right), bg));
    c.ansi(W - cellWidth(right), 0, right);
    // clickable chips
    const rw = cellWidth(right), mx = W - rw, mlen = cellWidth(modelChip), dlen = cellWidth(modeChip), slen = cellWidth(sideChip);
    this.regions.push({ x: mx, y: 0, w: mlen, h: 1, kind: "model", click: () => void app.runCommand("/model") }, { x: mx + mlen + 1, y: 0, w: dlen, h: 1, kind: "mode", click: () => { app.cycleMode(); app.render(); } },
      { x: mx + mlen + dlen + 2, y: 0, w: slen, h: 1, kind: "sidebar", click: () => { this.showSidebar = !this.showSidebar; this.invalidate(); } });
  }

  // ------------------------------------------------------------------ transcript
  private ctxFor(width: number, now: number): RenderCtx {
    const app = this.app, brand = brandOfModel(app.cfg.model, app.cfg.provider, this.theme);
    const exists = (p: string) => { let v = this.fileSeen.get(p); if (v === undefined) { try { const a = resolve(app.cwd, p); v = a.startsWith(resolve(app.cwd)) && existsSync(a) && statSync(a).isFile(); } catch { v = false; } this.fileSeen.set(p, v); } return v; };
    return { theme: this.theme, width, now, frame: app.frame, expandAll: this.expandAll, live: app.running, brand, diffMode: this.diffMode, kids: (id: string) => app.blocks.kids(id), exists };
  }
  private sig(b: Block, ctx: RenderCtx): string {
    const base = `${ctx.theme.name}|${ctx.width}|${ctx.diffMode}|${ctx.expandAll}|${ctx.brand.icon}|`;
    switch (b.kind) {
      case "user": return base + `${b.text.length}|${b.note ?? ""}|${b.queued ? 1 : 0}`;
      case "assistant": return base + `${b.text.length}|${b.streaming ? 1 + (ctx.frame >> 2) % 2 : 0}|${ctx.live}`;
      case "tool": return base + (b.name === "task" ? (() => { const k = ctx.kids?.(b.callId) ?? []; return `k${k.length}:${k.at(-1)?.status ?? ""}:${k.at(-1)?.id ?? ""}|`; })() : "") + `${b.status}|${b.result?.length ?? 0}|${b.expanded}|${b.more}|${b.edit?.diff.length ?? 0}|${b.ms ?? 0}|${b.status === "running" ? Math.floor(ctx.now / 100) + ":" + ctx.frame : ""}`;
      case "thinking": return base + `${b.text.length}|${b.active}|${b.expanded}|${b.active ? ctx.frame >> 1 : 0}`;
      case "notice": case "summary": return base + b.text.length;
      case "raw": return base + b.lines.length + ":" + (b.lines[0]?.length ?? 0);
    }
  }
  private drawTranscript(c: Canvas, t: Theme, x0: number, y0: number, w: number, h: number, now: number) {
    const app = this.app, W = w - 1, ctx = this.ctxFor(W, now);        // last column is the scrollbar
    this.items = []; let total = 0;
    if (!app.blocks.blocks.length) { this.drawEmpty(c, t, x0, y0, w, h); this.viewTop = y0; this.viewH = h; this.viewX = x0; this.viewW = w; this.total = 0; return; }
    const live = new Set<number>();
    const blocks = app.blocks.blocks.filter((b) => !(b.kind === "tool" && (b.name === "todo_write" || (b.parent && b.agent && b.agent !== "lead"))));   // todos live in the sidebar; a subagent's steps are drawn inside its card
    let prevTool: boolean = false;
    const lastTool = [...blocks].reverse().find((b) => b.kind === "tool" && (!b.agent || b.agent === "lead"))?.id;   // its output stays open
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]; live.add(b.id);
      let run = 1; if (isQuiet(b)) while (i + run < blocks.length && isQuiet(blocks[i + run])) run++;
      const tctx = { ...ctx, tight: prevTool, last: b.id === lastTool };
      if (run >= 2) {
        const members = blocks.slice(i, i + run) as Extract<Block, { kind: "tool" }>[], open = this.expandAll || this.groupOpen.has(b.id);
        const key: string = `g|${tctx.tight}|${open}|${ctx.theme.name}|${ctx.width}|` + members.map((m) => `${m.id}:${m.status}:${m.ms ?? 0}`).join(",") + (members.some((m) => m.status === "running") ? `|${ctx.frame}` : ""), hit = this.cache.get(b.id);
        const r: Rendered = hit && hit.key === key ? hit.r : (() => { const rr = renderGroup(members, open, tctx); this.cache.set(b.id, { key, r: rr }); return rr; })();
        for (const m of members) live.add(m.id);
        this.items.push({ b, r, start: total, group: true }); total += r.rows.length; i += run - 1; prevTool = r.rows.length <= 2; continue;
      }
      const key: string = this.sig(b, tctx) + (tctx.tight ? "|t" : "") + (tctx.last ? "|last" : ""), hit = this.cache.get(b.id);
      const r: Rendered = hit && hit.key === key ? hit.r : (() => { const rr = renderBlock(b, tctx); this.cache.set(b.id, { key, r: rr }); return rr; })();
      this.items.push({ b, r, start: total }); total += r.rows.length; prevTool = b.kind === "tool" && (!b.agent || b.agent === "lead") && r.rows.length <= 2;
    }
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    if (this.find) {
      const f = this.find; f.hits = findRows(this.items.flatMap((it) => it.r.text), f.q);
      if (f.jump) { f.cur = f.hits.length - 1; f.jump = false; this.prevTotal = total; if (f.cur >= 0) this.scroll = Math.max(0, total - h - (f.hits[f.cur].row - Math.floor(h / 2))); }   // newest match first
      f.cur = Math.min(f.cur, f.hits.length - 1);
    }
    if (this.scroll > 0 && total > this.prevTotal) { this.scroll += total - this.prevTotal; this.unseen += total - this.prevTotal; }   // keep the view anchored while scrolled up
    this.prevTotal = total;
    const maxScroll = Math.max(0, total - h); this.scroll = Math.max(0, Math.min(this.scroll, maxScroll)); if (this.scroll === 0) this.unseen = 0;
    const start = total <= h ? 0 : total - h - this.scroll;
    this.viewTop = y0; this.viewH = h; this.viewX = x0; this.viewW = w; this.total = total;
    let yy = 0;
    for (const it of this.items) {
      if (it.start + it.r.rows.length <= start) continue;
      if (it.start >= start + h) break;
      for (let k = 0; k < it.r.rows.length; k++) { const row = it.start + k - start; if (row >= 0 && row < h) c.put(x0, y0 + row, it.r.rows[k], W); }
      for (const hh of it.r.hits) { const row = it.start + hh.row - start; if (row >= 0 && row < h) this.regions.push({ x: x0 + hh.x0, y: y0 + row, w: hh.x1 - hh.x0, h: 1, kind: hh.kind, click: () => this.hitClick(hh, it.b, it.group) }); }
      yy = it.start + it.r.rows.length;
    }
    void yy;
    if (this.find) this.find.hits.forEach((m, i) => { const row = m.row - start; if (row >= 0 && row < h) c.tint(x0 + m.col, y0 + row, m.w, 1, i === this.find!.cur ? t.accent : t.selection); });
    // scrollbar
    if (total > h) {
      const thumb = Math.max(1, Math.round((h * h) / total)), top = Math.round(((start) / Math.max(1, total - h)) * (h - thumb));
      for (let r = 0; r < h; r++) c.text(x0 + W, y0 + r, r >= top && r < top + thumb ? "┃" : "│", { fg: r >= top && r < top + thumb ? t.dim : t.border });
      this.regions.push({ x: x0 + W, y: y0, w: 1, h, kind: "scrollbar", click: () => this.scrollTo(0) });
    }
    // sticky prompt: the last user message that scrolled off the top
    if (this.scroll > 0) {
      const above = [...this.items].reverse().find((i) => i.b.kind === "user" && i.start + i.r.rows.length <= start);
      if (above && above.b.kind === "user") {
        const text = clipWidth(above.b.text.replace(/\s+/g, " "), w - 18);
        c.ansi(x0, y0, fit(" " + F(t.accent, "▎") + " " + F(t.dim, text) + F(t.faint, "  ↑ prompt"), W, mix(t.surface2, t.bg, 0.2)));
        this.regions.push({ x: x0, y: y0, w: W, h: 1, kind: "sticky", click: () => this.scrollToBlock(above.b.id) });
      }
      const label = this.unseen > 0 ? ` ↓ Jump to bottom · ${this.unseen} new rows ` : " ↓ Jump to bottom ", lw = cellWidth(label), px = x0 + Math.floor((W - lw) / 2);
      c.text(px, y0 + h - 1, label, { fg: t.onAccent, bg: t.accent, attr: A.bold });
      this.regions.push({ x: px, y: y0 + h - 1, w: lw, h: 1, kind: "jump", click: () => this.scrollTo(0) });
    }
  }
  /** Opens a link; a test can replace it. */
  opener: (url: string) => Promise<boolean> = openUrl;
  private linkTimer?: ReturnType<typeof setTimeout>;
  /** A click on a link opens it in the browser. A double click copies the address instead, so it waits a moment to see which one this is. */
  private openLink(url: string) {
    if (this.linkTimer) { clearTimeout(this.linkTimer); this.linkTimer = undefined; }
    if (this.lastClick.n >= 2) { this.copy(url); this.toast("copied the link", "ok"); return; }
    const u = openableUrl(url); if (!u) { this.copy(url); this.toast("not a web link: copied instead", "warn"); return; }
    this.linkTimer = setTimeout(() => {
      this.linkTimer = undefined; this.toast(`opening ${u.host}`, "info"); this.app.render();
      void this.opener(u.href).then((ok) => { if (!ok) { this.copy(u.href); this.toast("could not open a browser here: link copied", "warn"); this.app.render(); } });
    }, 300);
  }
  private hitClick(h: Hit, b: Block, group = false) {
    if (h.kind === "link" && h.text) return this.openLink(h.text);
    if (h.kind === "file" && h.text) { const m = /^(.*?)(?::(\d+))?$/.exec(h.text)!; this.app.openFile(m[1], m[2] ? Number(m[2]) : undefined); return; }
    const before = this.total;
    if (h.kind === "copy" && h.text !== undefined) { this.copy(h.text); this.toast(`copied code block (${h.text.length} characters)`, "ok"); return; }
    if (group) { if (this.groupOpen.has(b.id)) this.groupOpen.delete(b.id); else this.groupOpen.add(b.id); }
    else if (h.kind === "toggle") this.app.blocks.toggle(b.id);
    else if (b.kind === "tool") { b.more = true; this.app.blocks.version++; }
    this.cache.delete(b.id); this.app.render();
    void before;
  }
  /** ctrl+f: start searching the conversation; typing narrows it live. */
  openFind() { this.find = { q: "", hits: [], cur: -1, back: this.scroll, jump: false }; }
  /** Keys while the find bar is open. Returns false for a key that closes it and should then act as usual. */
  findKey(k: Key): boolean {
    const f = this.find; if (!f) return false;
    const go = (d: number) => { if (!f.hits.length) return; f.cur = (f.cur + d + f.hits.length) % f.hits.length; const m = f.hits[f.cur]; this.scroll = Math.max(0, this.total - this.viewH - (m.row - Math.floor(this.viewH / 2))); };
    if (k.name === "escape") { this.scroll = f.back; this.find = undefined; return true; }
    if (k.name === "enter") { this.find = undefined; return true; }
    if (k.name === "up" || (k.ctrl && (k.name === "f" || k.name === "p"))) { go(-1); return true; }
    if (k.name === "down" || (k.ctrl && k.name === "n")) { go(1); return true; }
    if (k.name === "backspace") { f.q = [...f.q].slice(0, -1).join(""); f.jump = true; return true; }
    if ((k.name === "char" || k.name === "paste") && !k.ctrl && !k.alt && k.text) { f.q += k.text.replace(/\n/g, " "); f.jump = true; return true; }
    if (k.name === "mouse") return false;
    this.find = undefined; return false;
  }
  /** alt+↑ / alt+↓: jump to the previous or next of your own messages. */
  jumpPrompt(dir: -1 | 1) {
    const users = this.items.filter((i) => i.b.kind === "user"); if (!users.length) return;
    const top = Math.max(0, this.total - this.viewH - this.scroll);
    const target = dir < 0 ? [...users].reverse().find((u) => u.start < top) : users.find((u) => u.start > top);
    if (target) this.scrollToBlock(target.b.id); else if (dir > 0) this.scrollTo(0);
  }
  scrollTo(fromBottom: number) { this.scroll = Math.max(0, fromBottom); if (this.scroll === 0) this.unseen = 0; this.app.render(); }
  scrollBy(rows: number) { this.scroll = Math.max(0, this.scroll + rows); if (this.scroll === 0) this.unseen = 0; this.app.render(); }
  scrollToBlock(id: number) {
    const it = this.items.find((i) => i.b.id === id); if (!it) return;
    this.scroll = Math.max(0, this.total - this.viewH - it.start); this.app.render();
  }
  /** Keep a toggled block's header where it is on screen. */
  private pin(blockId: number, fn: () => void) {
    const it = this.items.find((i) => i.b.id === blockId), startBefore = it?.start ?? 0, totalBefore = this.total;
    fn(); void startBefore; void totalBefore;
  }

  // ------------------------------------------------------------------ empty state
  private drawEmpty(c: Canvas, t: Theme, x0: number, y0: number, w: number, h: number) {
    const app = this.app, lines: string[] = [];
    const lw0 = Math.max(...LOGO_ART.map((l) => cellWidth(l)));
    for (const [i, l] of LOGO_ART.entries()) lines.push(gradientText(l + " ".repeat(lw0 - cellWidth(l)), t.gradient, i * 0.06));
    lines.push("", F(t.dim, "reliable agents for any model"), "");
    const chips = [["Explain this repo", "Explain what this repository does and how it is organised. Keep it short."], ["Find & fix bugs", "Look for likely bugs in this repository and fix the clearest ones, verifying each fix."],
      ["Write tests", "Find the least-tested important code here and add focused tests for it."], ["Plan a feature", "__plan__"]];
    const y = y0 + Math.max(1, Math.floor((h - lines.length - 9) / 3));
    lines.forEach((l, i) => { const lw = i < LOGO_ART.length ? lw0 : cellWidth(l.replace(/\x1b\[[0-9;]*m/g, "")); c.ansi(x0 + Math.floor((w - lw) / 2), y + i, l); });
    let cx = 0; const widths = chips.map(([label]) => label.length + 4), totalW = widths.reduce((a, b) => a + b + 2, -2), startX = x0 + Math.floor((w - totalW) / 2), cy = y + lines.length;
    chips.forEach(([label, prompt], i) => {
      const ch = chip(label, t.text, t.surface2); c.ansi(startX + cx, cy, ch);
      const px = startX + cx, pw = widths[i]; cx += pw + 2;
      this.regions.push({ x: px, y: cy, w: pw, h: 1, kind: "action", click: () => { if (prompt === "__plan__") { app.setMode("plan"); app.editor.setText("Plan how to add: "); } else app.editor.setText(prompt); app.render(); } });
    });
    const recent = app.store.list().slice(0, 3);
    let ry = cy + 2;
    if (recent.length) {
      const hd = F(t.faint, BOLD("RECENT")); c.ansi(x0 + Math.floor((w - 6) / 2), ry++, hd);
      for (const s of recent) {
        const label = ` ↻ ${clipWidth(s.title || "(untitled)", 44)}  ${F(t.faint, `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${ago(s.updated)}`)} `, lw = cellWidth(label.replace(/\x1b\[[0-9;]*m/g, ""));
        const rx = x0 + Math.floor((w - lw) / 2); c.ansi(rx, ry, F(t.dim, label));
        this.regions.push({ x: rx, y: ry, w: lw, h: 1, kind: "recent", click: () => void app.resumeById(s.id) }); ry++;
      }
    }
    const hint = F(t.faint, "drag to select & copy  ·  Shift+drag for the terminal's own selection  ·  /copy copies the last reply"); c.ansi(x0 + Math.max(0, Math.floor((w - 94) / 2)), Math.min(y0 + h - 2, ry + 4), hint);
    const tip = F(t.faint, "tip  ") + F(t.dim, TIPS[this.tipIdx]); c.ansi(x0 + Math.max(0, Math.floor((w - cellWidth(TIPS[this.tipIdx]) - 5) / 2)), Math.min(y0 + h - 2, ry + 2), tip);
  }

  // ------------------------------------------------------------------ sidebar
  /** Steps the user opened in the LOOP section by clicking. */
  /** Which loop steps are open, the context-map cache and the tip: per-view state for the shared sidebar data (panel.ts). */
  private panel = newPanelState();
  private drawSidebar(c: Canvas, t: Theme, x0: number, y0: number, w: number, h: number) {
    const { rows, hits } = renderSidebar(sidebarData(this.app, this.panel, t, Date.now()), t, w, h);
    rows.forEach((r, i) => c.put(x0 + 1, y0 + i, r, w - 1));
    for (let i = 0; i < h; i++) c.text(x0, y0 + i, BORDERS[t.frame].v, { fg: t.border, bg: t.surface });
    for (const hh of hits) if (hh.row < h) this.regions.push({ x: x0, y: y0 + hh.row, w, h: 1, kind: "change", click: () => { if (hh.kind === "step" && hh.step !== undefined) { toggleStep(this.panel, hh.step); this.invalidate(); } else if (hh.blockId !== undefined) this.scrollToBlock(hh.blockId); } });
  }

  // ------------------------------------------------------------------ status line, input, footer
  private drawStatus(c: Canvas, t: Theme, x: number, y: number, w: number, now: number) {
    const app = this.app, f = app.frame, glyph = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"][f % 10];
    if (app.running) {
      const fl = [...app.inflight.values()], ph = app.phase?.phase;
      const verb = app.overlay ? "Waiting for you" : ph === "verify" ? "Verifying" : ph === "compact" ? "Compacting" : fl.length > 1 ? `Running ${fl.length} tools in parallel` : fl.length === 1 ? toolVerb(fl[0].name, fl[0].args)
        : app.mode === "plan" ? "Planning" : app.thinkBuf.trim() ? "Thinking" : app.streamBuf ? "Writing" : "Working", chars = [...clipWidth(verb, Math.max(8, w - 44)) + "…"];
      const shim = chars.map((ch, i) => F(mix(t.accent, 0xffffff, Math.max(0, 1 - Math.abs(i - ((f * 0.9) % (chars.length + 8) - 4)) / 3)), ch)).join("");
      const spark = app.runSeries.length > 1 ? " " + F(t.accent2, app.runSeries.slice(-10).map((v) => BARS[Math.min(7, Math.round((v / Math.max(1, ...app.runSeries)) * 7))]).join("")) : "";
      c.ansi(x + 1, y, F(mix(t.accent, t.accent2, (f % 20) / 20), glyph) + " " + BOLD(shim) + F(t.dim, ` ${fmtDuration(now - app.runStart)} · ↓ ${fmtTokens(app.runTokens)}`) + (app.phase ? (() => { const n = app.phase.step + 1, cap = capNote(n, app.phase.max); return F(cap.level === "warn" ? t.warn : t.faint, ` · step ${n}${cap.level === "none" ? "" : cap.level === "dim" ? ` of ${app.phase.max}` : ` of ${app.phase.max}, near the limit`}`); })() : "") + spark + F(t.faint, "   esc to interrupt"), {}, w - 2);
      if (app.thinkBuf.trim() && app.queued.length === 0) { /* reasoning summary lives in the transcript's thinking block */ }
    }
    app.queued.slice(0, 2).forEach((q, i) => c.ansi(x + 1, y + (app.running ? 1 : 0) + i, F(t.warn, "▸ queued ") + F(t.dim, clipWidth(q.text.replace(/\s+/g, " "), w - 14)), {}, w - 2));
  }
  private editorRows(width: number): number { const r = this.app.editor.render(Math.max(10, width), "", ""); return Math.max(1, Math.min(8, r.lines.length)); }
  private drawInput(c: Canvas, t: Theme, x: number, y: number, w: number, h: number) {
    const app = this.app, mode = app.mode, col = mode === "yolo" ? t.err : mode === "plan" ? t.info : mode === "acceptEdits" ? t.ok : t.accent;
    const dimBorder = app.running ? mix(col, t.bg, 0.55) : col;
    c.box(x, y, w, h, { border: dimBorder, bg: t.surface, style: t.frame });
    const label = ` ${MODE_LABEL[mode] ?? mode} `;
    c.text(x + 2, y, label, { fg: t.onAccent, bg: col, attr: A.bold });
    this.regions.push({ x: x + 2, y, w: label.length, h: 1, kind: "mode", click: () => { app.cycleMode(); app.render(); } });
    const hint = app.running ? " enter queues · esc interrupts " : app.vimNormal ? " NORMAL · i insert · enter send " : app.cfg.vim ? " INSERT · esc normal " : " ⇧⇥ mode  ⌥↵ newline ";
    c.text(x + w - cellWidth(hint) - 2, y, hint, { fg: t.faint, bg: t.surface });
    const ed = app.editor, innerW = w - 6, r = ed.render(innerW, "", ""), rows = Math.min(8, r.lines.length);
    const first = Math.max(0, Math.min(r.cursor.row - rows + 1, r.lines.length - rows)), shown = r.lines.slice(first, first + rows);
    const empty = ed.empty;
    shown.forEach((ln, i) => {
      const yy = y + 1 + i, prompt = i === 0 && first === 0 ? (app.vimNormal ? F(t.accent2, BOLD("N")) : F(col, BOLD("❯"))) : " ";
      c.ansi(x + 2, yy, prompt, { bg: t.surface });
      if (empty && i === 0) c.ansi(x + 4, yy, F(t.faint, ITAL(app.running ? "Type to steer the agent…" : "Ask anything…   @ files  ·  / commands  ·  !cmd run a command  ·  # remember")), { bg: t.surface }, innerW);
      else c.ansi(x + 4, yy, ln.replace(/(@[^\s]+)/g, (m) => F(t.accent2, m)).replace(/\[Pasted text #\d+ \+\d+ lines?\]/g, (m) => F(t.warn, m)), { bg: t.surface, fg: t.text }, innerW);
    });
    if (!app.overlay) c.cursor = { x: x + 4 + r.cursor.col, y: y + 1 + (r.cursor.row - first) };
    this.regions.push({ x: x + 1, y: y + 1, w: w - 2, h: rows, kind: "input", click: () => { /* focus is implicit */ } });
  }
  private drawSuggestions(c: Canvas, t: Theme, x: number, inputY: number, mainW: number) {
    const s = this.app.sugg; if (!s || !s.items.length || this.app.overlay) return;
    const w = Math.min(86, mainW), room = inputY - 4;                       // rows between the top of the screen and the box
    if (room < 3) return;
    const { rows, above, below } = menuRows(s.items, s.sel, Math.min(14, room)), y = inputY - rows.length - 2;
    const pos = s.items.length > rows.filter((r) => "item" in r).length ? `  ${s.sel + 1}/${s.items.length}${above ? " ↑" : ""}${below ? " ↓" : ""}` : "";
    c.box(x + 1, y, w, rows.length + 2, { border: t.border, bg: t.surface, style: t.frame, title: (s.kind === "slash" ? "commands" : s.kind === "arg" ? `/${s.token.cmd} options` : "files") + pos, titleFg: t.dim });
    rows.forEach((r, i) => {
      if ("head" in r) { c.ansi(x + 2, y + 1 + i, fit(" " + F(t.faint, "── ") + BOLD(F(t.dim, r.head)) + " " + F(t.faint, "─".repeat(Math.max(2, 24 - r.head.length))), w - 2, t.surface), {}, w - 2); return; }
      const idx = r.item, it = s.items[idx], on = idx === s.sel, bg = on ? t.selection : t.surface;
      const label = s.kind === "file" ? (() => { const n = it.label.split("/").pop()!, d = it.label.slice(0, it.label.length - n.length); return F(t.faint, d) + BOLD(F(t.text, n)); })() : BOLD(F(t.accent2, it.label.padEnd(16)));
      c.ansi(x + 2, y + 1 + i, fit((on ? F(t.accent, "▌") : " ") + " " + label + (it.detail ? "  " + F(t.faint, it.detail) : ""), w - 2, bg), {}, w - 2);
      this.regions.push({ x: x + 2, y: y + 1 + i, w: w - 2, h: 1, kind: "sugg", click: () => { s.sel = idx; this.app.acceptSuggPublic(true); } });
    });
  }
  private drawFooter(c: Canvas, t: Theme, W: number, y: number, now: number) {
    const app = this.app, hints: [string, string][] = app.overlay ? [] : app.running ? [["esc", "interrupt"], ["enter", "queue message"], ["ctrl+o", "expand all"]]
      : app.editor.empty ? [["enter", "send"], ["ctrl+p", "commands"], ["ctrl+o", "expand tools"], ["ctrl+b", "sidebar"], ["pgup/dn", "scroll"], ["?", "help"]] : [["enter", "send"], ["⌥enter", "newline"], ["tab", "complete"], ["esc esc", "clear"]];
    const left = hints.map(([k, l]) => F(t.dim, k) + " " + F(t.faint, l)).join(F(t.border, "  ·  "));
    const p = app.ctxPct, cost = app.cost, right = [p !== null ? F(p > 85 ? t.err : p > 60 ? t.warn : t.dim, `ctx ${p}%`) : "", cost ? F(t.dim, cost) : "", this.mouseOn ? "" : F(t.warn, "mouse off")].filter(Boolean).join(F(t.border, "  ·  "));
    if (this.find) {
      const f = this.find, n = f.hits.length, pos = !f.q ? "" : n ? `${f.cur + 1}/${n}` : "no match";
      c.ansi(0, y, fit(" " + BOLD(F(t.accent, "Find")) + " " + F(t.text, f.q) + F(t.accent, "▏") + "  " + F(n || !f.q ? t.dim : t.warn, pos) + "   " + F(t.faint, "↑ older · ↓ newer · enter stay · esc back"), W, t.bg));
      return;
    }
    if (t.keybar && hints.length && !(app.notice && now < app.noticeUntil)) { this.drawKeybar(c, t.keybar, hints, W - cellWidth(right) - 1, y, t.bg); if (right) c.ansi(W - cellWidth(right) - 1, y, right); return; }
    c.ansi(0, y, fit(" " + (app.notice && now < app.noticeUntil ? F(t.warn, app.notice) : left), W - cellWidth(right) - 1, t.bg));
    if (right) c.ansi(W - cellWidth(right) - 1, y, right);
  }
  /** The retro key bar: each hint is a key on a dark cell and its label on a light bar, the cells stretched to share the width. */
  private drawKeybar(c: Canvas, k: NonNullable<Theme["keybar"]>, hints: [string, string][], w: number, y: number, bg: number) {
    c.fill(0, y, w, 1, bg);
    const cell = Math.floor(w / hints.length);
    if (cell < 6) return;
    hints.forEach(([key, label], i) => {
      const x = i * cell, kw = Math.min(cellWidth(key) + 1, cell - 3);
      c.fill(x, y, kw, 1, k.keyBg); c.text(x, y, clipWidth(key, kw - 1), { fg: k.key, bg: k.keyBg, attr: A.bold });
      c.fill(x + kw, y, cell - kw - 1, 1, k.labelBg); c.text(x + kw, y, clipWidth(label, cell - kw - 1), { fg: k.label, bg: k.labelBg });
    });
  }
  private drawToasts(c: Canvas, t: Theme, W: number) {
    this.toasts.forEach((ts, i) => {
      const col = ts.kind === "ok" ? t.ok : ts.kind === "warn" ? t.warn : ts.kind === "error" ? t.err : t.accent2, icon = ts.kind === "ok" ? "✓" : ts.kind === "warn" ? "⚠" : ts.kind === "error" ? "✗" : "●";
      const n = this.toasts.length, text = clipWidth(` ${icon} ${ts.text} `, Math.max(10, this.mainW - 6)), w = cellWidth(text) + 2, x = 2, y = this.toastBase - 3 * (n - i);   // bottom-left of the transcript: never covers the header or sidebar
      c.box(x, y, w, 3, { border: col, bg: t.surface2, style: t.frame }); c.text(x + 1, y + 1, text, { fg: t.text, bg: t.surface2 });
      c.text(x + 2, y + 1, icon, { fg: col, bg: t.surface2 });
    });
  }
  private drawSelection(c: Canvas, t: Theme) {
    const s = this.sel; if (!s) return;
    const [a, b] = ordered(s);
    if (s.mode === "block") { const lo = Math.min(s.ax, s.hx), hi = Math.max(s.ax, s.hx); for (let y = a.y; y <= b.y; y++) c.tint(lo, y, hi - lo + 1, 1, t.selection); return; }
    for (let y = a.y; y <= b.y; y++) { const x0 = y === a.y ? a.x : this.viewX, x1 = y === b.y ? b.x : this.viewX + this.viewW - 2; c.tint(x0, y, x1 - x0 + 1, 1, t.selection); }
  }

  // ------------------------------------------------------------------ mouse
  mouse(e: MouseEv) {
    const app = this.app;
    if (e.action === "wheelup" || e.action === "wheeldown") {
      const now = Date.now(), step = now - this.lastWheel < 70 ? 5 : 3; this.lastWheel = now;
      const o = app.overlay;
      if (o instanceof PickerOverlay) { o.key({ name: e.action === "wheelup" ? "up" : "down" }); app.render(); return; }
      if (o instanceof TextOverlay) { o.scroll += e.action === "wheelup" ? -3 : 3; app.render(); return; }
      if (o) return;
      this.scrollBy(e.action === "wheelup" ? step : -step); return;
    }
    if (e.button !== "left") return;
    const inTr = e.x >= this.viewX && e.x < this.viewX + this.viewW - 1 && e.y >= this.viewTop && e.y < this.viewTop + this.viewH;
    if (e.action === "press") {
      const inTr0 = !app.overlay && e.x >= this.viewX && e.x < this.viewX + this.viewW - 1 && e.y >= this.viewTop && e.y < this.viewTop + this.viewH;
      this.down = { x: e.x, y: e.y, moved: false, mode: inTr0 ? "lines" : "block" }; this.sel = undefined;
      if (this.input(e)) return;
    } else if (e.action === "drag" && this.down) {
      if (Math.abs(e.x - this.down.x) + Math.abs(e.y - this.down.y) > 0) {
        this.down.moved = true;
        const lines = this.down.mode === "lines";
        const y = lines ? Math.max(this.viewTop, Math.min(this.viewTop + this.viewH - 1, e.y)) : Math.max(0, Math.min(this.canvas.h - 1, e.y)), x = lines ? Math.max(this.viewX, Math.min(this.viewX + this.viewW - 2, e.x)) : Math.max(0, Math.min(this.canvas.w - 1, e.x));
        this.sel = { ax: this.down.x, ay: lines ? Math.max(this.viewTop, Math.min(this.viewTop + this.viewH - 1, this.down.y)) : this.down.y, hx: x, hy: y, done: false, mode: this.down.mode };
        if (lines) { if (e.y < this.viewTop) this.scrollBy(1); else if (e.y >= this.viewTop + this.viewH) this.scrollBy(-1); }
        app.render();
      }
    } else if (e.action === "release" && this.down) {
      const d = this.down; this.down = undefined;
      if (d.moved && this.sel) { this.sel.done = true; this.copySelection(); app.render(); return; }
      if (d.moved) return;
      const now = Date.now(), n = now - this.lastClick.t < 450 && this.lastClick.x === e.x && this.lastClick.y === e.y ? this.lastClick.n + 1 : 1;
      this.lastClick = { t: now, x: e.x, y: e.y, n };
      const handled = this.click(e.x, e.y);
      if (!handled && n >= 2) this.selectAt(e.x, e.y, n >= 3 ? "line" : "word");
    }
  }
  /** Double click selects the word under the pointer, triple click the whole line; both copy at once. */
  private selectAt(x: number, y: number, what: "word" | "line") {
    const lo = x >= this.sideX ? this.sideX : this.viewX, hi = x >= this.sideX ? this.canvas.w - 1 : this.viewX + this.viewW - 2;
    const row = this.canvas.readRow(y, lo, hi + 1), at = x - lo; if (at < 0 || at >= row.length) return;
    let a = 0, z = row.length - 1;
    if (what === "word") { if (/\s/.test(row[at])) return; a = at; z = at; while (a > 0 && !/\s/.test(row[a - 1])) a--; while (z < row.length - 1 && !/\s/.test(row[z + 1])) z++; }
    else { while (z > 0 && /\s/.test(row[z])) z--; while (a < z && /\s/.test(row[a])) a++; }
    this.sel = { ax: lo + a, ay: y, hx: lo + z, hy: y, done: true, mode: "block" }; this.copySelection(); this.app.render();
  }
  /** Clicks inside the input panel move the text cursor. */
  private input(e: MouseEv): boolean { void e; return false; }
  private click(x: number, y: number): boolean {
    for (let i = this.regions.length - 1; i >= 0; i--) { const r = this.regions[i]; if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h && r.click) { r.click(); return true; } }
    return false;
  }
  private modalClick(h: ModalHit) {
    const o = this.app.overlay;
    if (o instanceof ChoiceOverlay && h.kind === "option") o.done(h.index);
    else if (o instanceof PickerOverlay && h.kind === "item") o.pick(h.index);
    this.app.render();
  }
  private copySelection() {
    const s = this.sel; if (!s) return; const [a, b] = ordered(s); const lines: string[] = [];
    for (let y = a.y; y <= b.y; y++) {
      if (s.mode === "block") lines.push(this.canvas.readRow(y, Math.min(s.ax, s.hx), Math.max(s.ax, s.hx) + 1));
      else lines.push(this.canvas.readRow(y, y === a.y ? a.x : this.viewX, (y === b.y ? b.x : this.viewX + this.viewW - 2) + 1));
    }
    const text = lines.map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\s+$/g, "");
    if (!text) return;
    this.copy(text); this.toast(`copied ${text.length} characters`, "ok");
  }
  copy(text: string) { copyToClipboard(this.app.io.output, text, this.app.persist); }
  clearSelection() { if (this.sel) { this.sel = undefined; return true; } return false; }
  /** Scroll keys; returns whether the key was used. */
  key(name: string, ctrl?: boolean): boolean {
    if (this.app.sugg && (name === "pageup" || name === "pagedown")) return false; // the open menu pages through its list instead
    const page = Math.max(3, Math.floor(this.viewH / 2));
    if (name === "pageup") { this.scrollBy(page); return true; } if (name === "pagedown") { this.scrollBy(-page); return true; }
    if (ctrl && name === "home") { this.scrollTo(Math.max(0, this.total)); return true; } if (ctrl && name === "end") { this.scrollTo(0); return true; }
    return false;
  }
}

const ordered = (s: { ax: number; ay: number; hx: number; hy: number }) => (s.ay < s.hy || (s.ay === s.hy && s.ax <= s.hx) ? [{ x: s.ax, y: s.ay }, { x: s.hx, y: s.hy }] : [{ x: s.hx, y: s.hy }, { x: s.ax, y: s.ay }]) as [{ x: number; y: number }, { x: number; y: number }];
export function gradientText(text: string, stops: number[], phase = 0): string {
  const chars = [...text], n = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => (ch === " " ? ch : F(sample(stops, (i / n + phase) % 1), ch))).join("");
}
const sample = (stops: number[], x: number) => { const p = Math.max(0, Math.min(1, x)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)); return stops.length === 1 ? stops[0] : mix(stops[i], stops[i + 1], p - i); };
function ago(iso: string) { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; }
void InputOverlay; void ITAL; void BOLD; void split; void estimateCost; void ({} as Cell);

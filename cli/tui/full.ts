// The full-screen UI: header, scrollable transcript, sidebar, input panel, modals, toasts and mouse handling, drawn on a cell canvas.
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { App } from "./app.ts";
import { A, mix, type Cell } from "./ansi.ts";
import { brandOfModel } from "./brand.ts";
import { Canvas } from "./canvas.ts";
import { isQuiet, renderBlock, renderGroup, type Hit, type RenderCtx, type Rendered } from "./cards.ts";
import type { Block } from "./blocks.ts";
import type { MouseEv } from "./keys.ts";
import { MOUSE_OFF, MOUSE_ON } from "./keys.ts";
import { drawModal, type ModalHit } from "./modal.ts";
import { ChoiceOverlay, InputOverlay, PickerOverlay, TextOverlay } from "./overlays.ts";
import { contextWindow, estimateCost, fmtDuration, fmtTokens } from "./pricing.ts";
import { BOLD, F, ITAL, chip, fit, split } from "./rich.ts";
import { renderSidebar } from "./sidebar.ts";
import { cellWidth, clipWidth } from "./text.ts";
import { getTheme, type Theme } from "./themes.ts";
import { level as colorLevel, TIPS } from "./theme.ts";
import { contextMap } from "./tokens.ts";
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
  private sel?: { ax: number; ay: number; hx: number; hy: number; done: boolean };
  private down?: { x: number; y: number; moved: boolean };
  private lastWheel = 0;
  private ctxCache?: { key: string; map: { label: string; pct: number; color: number }[] };
  private forceFull = true;
  private tipIdx = Math.floor(Math.random() * TIPS.length);
  private startedAt = Date.now();

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
  invalidate() { this.forceFull = true; this.cache.clear(); }

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
    return { theme: this.theme, width, now, frame: app.frame, expandAll: this.expandAll, live: app.running, brand, diffMode: this.diffMode };
  }
  private sig(b: Block, ctx: RenderCtx): string {
    const base = `${ctx.theme.name}|${ctx.width}|${ctx.diffMode}|${ctx.expandAll}|${ctx.brand.icon}|`;
    switch (b.kind) {
      case "user": return base + `${b.text.length}|${b.note ?? ""}|${b.queued ? 1 : 0}`;
      case "assistant": return base + `${b.text.length}|${b.streaming ? 1 + (ctx.frame >> 2) % 2 : 0}|${ctx.live}`;
      case "tool": return base + `${b.status}|${b.result?.length ?? 0}|${b.expanded}|${b.more}|${b.edit?.diff.length ?? 0}|${b.ms ?? 0}|${b.status === "running" ? Math.floor(ctx.now / 100) + ":" + ctx.frame : ""}`;
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
    const blocks = app.blocks.blocks.filter((b) => !(b.kind === "tool" && b.name === "todo_write"));   // todos live in the sidebar
    let prevTool: boolean = false;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]; live.add(b.id);
      let run = 1; if (isQuiet(b)) while (i + run < blocks.length && isQuiet(blocks[i + run])) run++;
      const tctx = { ...ctx, tight: prevTool };
      if (run >= 2) {
        const members = blocks.slice(i, i + run) as Extract<Block, { kind: "tool" }>[], open = this.expandAll || this.groupOpen.has(b.id);
        const key: string = `g|${tctx.tight}|${open}|${ctx.theme.name}|${ctx.width}|` + members.map((m) => `${m.id}:${m.status}:${m.ms ?? 0}`).join(",") + (members.some((m) => m.status === "running") ? `|${ctx.frame}` : ""), hit = this.cache.get(b.id);
        const r: Rendered = hit && hit.key === key ? hit.r : (() => { const rr = renderGroup(members, open, tctx); this.cache.set(b.id, { key, r: rr }); return rr; })();
        for (const m of members) live.add(m.id);
        this.items.push({ b, r, start: total, group: true }); total += r.rows.length; i += run - 1; prevTool = r.rows.length <= 2; continue;
      }
      const key: string = this.sig(b, tctx) + (tctx.tight ? "|t" : ""), hit = this.cache.get(b.id);
      const r: Rendered = hit && hit.key === key ? hit.r : (() => { const rr = renderBlock(b, tctx); this.cache.set(b.id, { key, r: rr }); return rr; })();
      this.items.push({ b, r, start: total }); total += r.rows.length; prevTool = b.kind === "tool" && (!b.agent || b.agent === "lead") && r.rows.length <= 2;
    }
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
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
  private hitClick(h: Hit, b: Block, group = false) {
    const before = this.total;
    if (group) { if (this.groupOpen.has(b.id)) this.groupOpen.delete(b.id); else this.groupOpen.add(b.id); }
    else if (h.kind === "toggle") this.app.blocks.toggle(b.id);
    else if (b.kind === "tool") { b.more = true; this.app.blocks.version++; }
    this.cache.delete(b.id); this.app.render();
    void before;
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
    const tip = F(t.faint, "tip  ") + F(t.dim, TIPS[this.tipIdx]); c.ansi(x0 + Math.max(0, Math.floor((w - cellWidth(TIPS[this.tipIdx]) - 5) / 2)), Math.min(y0 + h - 2, ry + 2), tip);
  }

  // ------------------------------------------------------------------ sidebar
  private drawSidebar(c: Canvas, t: Theme, x0: number, y0: number, w: number, h: number) {
    const app = this.app, u = app.session.usage, win = contextWindow(app.cfg.model), now = Date.now();
    const mkey = `${app.session.messages.length}|${app.lastPrompt}`;
    if (this.ctxCache?.key !== mkey) {
      const m = contextMap(app.session.messages, app.lastPrompt, JSON.stringify(app.agent.registry.visible({ step: 0, messages: [] }).map((x) => x.name + x.description)).length);
      const tot = Math.max(1, m.total), cols: Record<string, number> = { tools: t.tool.read, assistant: t.tool.edit, you: t.ok, system: t.accent, defs: t.accent2 };
      this.ctxCache = { key: mkey, map: m.parts.map((p) => ({ label: p.label, pct: Math.round((p.tokens / tot) * 100), color: cols[p.key] })).sort((a, b) => b.pct - a.pct) };
    }
    const changes = new Map<string, { path: string; added: number; removed: number; created: boolean; blockId: number }>();
    for (const b of app.blocks.blocks) if (b.kind === "tool" && b.edit) { const p = changes.get(b.edit.path); changes.set(b.edit.path, { path: b.edit.path, added: (p?.added ?? 0) + b.edit.added, removed: (p?.removed ?? 0) + b.edit.removed, created: p?.created ?? b.edit.created, blockId: b.id }); }
    const used = app.lastPrompt || this.ctxCache.map.reduce((n, m) => n + m.pct, 0) * 0;
    const { rows, hits } = renderSidebar({
      title: app.session.title, model: app.cfg.model, provider: app.cfg.provider, api: app.model.api?.(), branch: app.branch, cwd: shortPath(app.cwd), mode: app.mode, effort: app.cfg.effort,
      ctxPct: app.ctxPct, ctxUsed: used, ctxMax: win, series: u.series ?? [], map: this.ctxCache.map,
      usage: { prompt: u.prompt, completion: u.completion, calls: u.calls, cached: u.cached ?? 0, reasoning: u.reasoning ?? 0 }, cost: estimateCost(app.cfg.model, u.prompt, u.completion, u.cached ?? 0),
      todos: app.todos, changes: [...changes.values()].reverse(), tools: app.agent.registry.visible({ step: 0, messages: [] }).length, mcp: app.mcp.length, memory: app.memory?.list().length ?? 0,
      running: app.running, elapsedMs: now - this.startedAt, tip: TIPS[this.tipIdx],
      run: app.running ? { phase: app.phase?.phase ?? "model", step: app.phase?.step ?? 0, max: app.phase?.max ?? 30, elapsedMs: now - app.runStart, frame: app.frame,
        live: [...app.inflight.values()].map((x) => ({ label: toolVerb(x.name, x.args), ms: now - x.t0, agent: x.agent })), done: app.activity.map((x) => ({ label: toolVerb(x.name, x.args, true), ok: x.ok, ms: x.ms })) } : undefined,
    }, t, w, h);
    rows.forEach((r, i) => c.put(x0 + 1, y0 + i, r, w - 1));
    for (let i = 0; i < h; i++) c.text(x0, y0 + i, "│", { fg: t.border, bg: t.surface });
    for (const hh of hits) if (hh.row < h) this.regions.push({ x: x0, y: y0 + hh.row, w, h: 1, kind: "change", click: () => hh.blockId !== undefined && this.scrollToBlock(hh.blockId) });
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
      c.ansi(x + 1, y, F(mix(t.accent, t.accent2, (f % 20) / 20), glyph) + " " + BOLD(shim) + F(t.dim, ` ${fmtDuration(now - app.runStart)} · ↓ ${fmtTokens(app.runTokens)}`) + (app.phase ? F(t.faint, ` · step ${app.phase.step + 1}/${app.phase.max}`) : "") + spark + F(t.faint, "   esc to interrupt"), {}, w - 2);
      if (app.thinkBuf.trim() && app.queued.length === 0) { /* reasoning summary lives in the transcript's thinking block */ }
    }
    app.queued.slice(0, 2).forEach((q, i) => c.ansi(x + 1, y + (app.running ? 1 : 0) + i, F(t.warn, "▸ queued ") + F(t.dim, clipWidth(q.text.replace(/\s+/g, " "), w - 14)), {}, w - 2));
  }
  private editorRows(width: number): number { const r = this.app.editor.render(Math.max(10, width), "", ""); return Math.max(1, Math.min(8, r.lines.length)); }
  private drawInput(c: Canvas, t: Theme, x: number, y: number, w: number, h: number) {
    const app = this.app, mode = app.mode, col = mode === "yolo" ? t.err : mode === "plan" ? t.info : mode === "acceptEdits" ? t.ok : t.accent;
    const dimBorder = app.running ? mix(col, t.bg, 0.55) : col;
    c.box(x, y, w, h, { border: dimBorder, bg: t.surface, style: "round" });
    const label = ` ${MODE_LABEL[mode] ?? mode} `;
    c.text(x + 2, y, label, { fg: t.onAccent, bg: col, attr: A.bold });
    this.regions.push({ x: x + 2, y, w: label.length, h: 1, kind: "mode", click: () => { app.cycleMode(); app.render(); } });
    const hint = app.running ? " enter queues · esc interrupts " : " ⇧⇥ mode  ⌥↵ newline ";
    c.text(x + w - cellWidth(hint) - 2, y, hint, { fg: t.faint, bg: t.surface });
    const ed = app.editor, innerW = w - 6, r = ed.render(innerW, "", ""), rows = Math.min(8, r.lines.length);
    const first = Math.max(0, Math.min(r.cursor.row - rows + 1, r.lines.length - rows)), shown = r.lines.slice(first, first + rows);
    const empty = ed.empty;
    shown.forEach((ln, i) => {
      const yy = y + 1 + i, prompt = i === 0 && first === 0 ? F(col, BOLD("❯")) : " ";
      c.ansi(x + 2, yy, prompt, { bg: t.surface });
      if (empty && i === 0) c.ansi(x + 4, yy, F(t.faint, ITAL(app.running ? "Type to steer the agent…" : "Ask anything…   @ files  ·  / commands  ·  ! shell  ·  # remember")), { bg: t.surface }, innerW);
      else c.ansi(x + 4, yy, ln.replace(/(@[^\s]+)/g, (m) => F(t.accent2, m)).replace(/\[Pasted text #\d+ \+\d+ lines?\]/g, (m) => F(t.warn, m)), { bg: t.surface, fg: t.text }, innerW);
    });
    if (!app.overlay) c.cursor = { x: x + 4 + r.cursor.col, y: y + 1 + (r.cursor.row - first) };
    this.regions.push({ x: x + 1, y: y + 1, w: w - 2, h: rows, kind: "input", click: () => { /* focus is implicit */ } });
  }
  private drawSuggestions(c: Canvas, t: Theme, x: number, inputY: number, mainW: number) {
    const s = this.app.sugg; if (!s || !s.items.length || this.app.overlay) return;
    const rows = Math.min(8, s.items.length), w = Math.min(70, mainW), top = Math.max(0, Math.min(s.sel - 3, s.items.length - rows)), y = inputY - rows - 2;
    if (y < 1) return;
    c.box(x + 1, y, w, rows + 2, { border: t.border, bg: t.surface, style: "round", title: s.kind === "slash" ? "commands" : "files", titleFg: t.dim });
    s.items.slice(top, top + rows).forEach((it, i) => {
      const idx = top + i, on = idx === s.sel, bg = on ? t.selection : t.surface;
      const label = s.kind === "file" ? (() => { const n = it.label.split("/").pop()!, d = it.label.slice(0, it.label.length - n.length); return F(t.faint, d) + BOLD(F(t.text, n)); })() : BOLD(F(t.accent2, it.label));
      c.ansi(x + 2, y + 1 + i, fit((on ? F(t.accent, "▌") : " ") + " " + label + (it.detail ? "  " + F(t.faint, it.detail) : ""), w - 2, bg), {}, w - 2);
      this.regions.push({ x: x + 2, y: y + 1 + i, w: w - 2, h: 1, kind: "sugg", click: () => { s.sel = idx; this.app.acceptSuggPublic(true); } });
    });
  }
  private drawFooter(c: Canvas, t: Theme, W: number, y: number, now: number) {
    const app = this.app, hints: [string, string][] = app.overlay ? [] : app.running ? [["esc", "interrupt"], ["enter", "queue message"], ["ctrl+o", "expand all"]]
      : app.editor.empty ? [["enter", "send"], ["ctrl+p", "commands"], ["ctrl+o", "expand tools"], ["ctrl+b", "sidebar"], ["pgup/dn", "scroll"], ["?", "help"]] : [["enter", "send"], ["⌥enter", "newline"], ["tab", "complete"], ["esc esc", "clear"]];
    const left = hints.map(([k, l]) => F(t.dim, k) + " " + F(t.faint, l)).join(F(t.border, "  ·  "));
    const p = app.ctxPct, cost = app.cost, right = [p !== null ? F(p > 85 ? t.err : p > 60 ? t.warn : t.dim, `ctx ${p}%`) : "", cost ? F(t.dim, cost) : "", this.mouseOn ? "" : F(t.warn, "mouse off")].filter(Boolean).join(F(t.border, "  ·  "));
    c.ansi(0, y, fit(" " + (app.notice && now < app.noticeUntil ? F(t.warn, app.notice) : left), W - cellWidth(right) - 1, t.bg));
    if (right) c.ansi(W - cellWidth(right) - 1, y, right);
  }
  private drawToasts(c: Canvas, t: Theme, W: number) {
    this.toasts.forEach((ts, i) => {
      const col = ts.kind === "ok" ? t.ok : ts.kind === "warn" ? t.warn : ts.kind === "error" ? t.err : t.accent2, icon = ts.kind === "ok" ? "✓" : ts.kind === "warn" ? "⚠" : ts.kind === "error" ? "✗" : "●";
      const text = ` ${icon} ${ts.text} `, w = cellWidth(text) + 2, x = W - w - 2, y = 2 + i * 3;
      c.box(x, y, w, 3, { border: col, bg: t.surface2, style: "round" }); c.text(x + 1, y + 1, text, { fg: t.text, bg: t.surface2 });
      c.text(x + 2, y + 1, icon, { fg: col, bg: t.surface2 });
    });
  }
  private drawSelection(c: Canvas, t: Theme) {
    const s = this.sel; if (!s) return;
    const [a, b] = ordered(s);
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
      this.down = { x: e.x, y: e.y, moved: false }; this.sel = undefined;
      if (this.input(e)) return;
    } else if (e.action === "drag" && this.down) {
      if (!app.overlay && (inTr || this.sel) && (Math.abs(e.x - this.down.x) + Math.abs(e.y - this.down.y) > 0)) {
        this.down.moved = true;
        const y = Math.max(this.viewTop, Math.min(this.viewTop + this.viewH - 1, e.y)), x = Math.max(this.viewX, Math.min(this.viewX + this.viewW - 2, e.x));
        this.sel = { ax: this.down.x, ay: Math.max(this.viewTop, Math.min(this.viewTop + this.viewH - 1, this.down.y)), hx: x, hy: y, done: false };
        if (e.y < this.viewTop) this.scrollBy(1); else if (e.y >= this.viewTop + this.viewH) this.scrollBy(-1);
        app.render();
      }
    } else if (e.action === "release" && this.down) {
      const d = this.down; this.down = undefined;
      if (d.moved && this.sel) { this.sel.done = true; this.copySelection(); app.render(); return; }
      if (!d.moved) this.click(e.x, e.y);
    }
  }
  /** Clicks inside the input panel move the text cursor. */
  private input(e: MouseEv): boolean { void e; return false; }
  private click(x: number, y: number) {
    for (let i = this.regions.length - 1; i >= 0; i--) { const r = this.regions[i]; if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h && r.click) { r.click(); return; } }
  }
  private modalClick(h: ModalHit) {
    const o = this.app.overlay;
    if (o instanceof ChoiceOverlay && h.kind === "option") o.done(h.index);
    else if (o instanceof PickerOverlay && h.kind === "item") o.pick(h.index);
    this.app.render();
  }
  private copySelection() {
    const s = this.sel; if (!s) return; const [a, b] = ordered(s); const lines: string[] = [];
    for (let y = a.y; y <= b.y; y++) lines.push(this.canvas.readRow(y, y === a.y ? a.x : this.viewX, (y === b.y ? b.x : this.viewX + this.viewW - 2) + 1));
    const text = lines.join("\n").replace(/\s+$/g, "");
    if (!text) return;
    this.copy(text); this.toast(`copied ${text.length} characters`, "ok");
  }
  /** Clipboard: OSC 52 (works over SSH in most modern terminals) plus the platform tool when we are local. */
  copy(text: string) {
    this.app.io.output.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    if (!this.app.persist) return;
    const cmd = process.platform === "darwin" ? ["pbcopy"] : process.env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
    try { const p = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); } catch { /* no clipboard tool: OSC 52 only */ }
  }
  clearSelection() { if (this.sel) { this.sel = undefined; return true; } return false; }
  /** Scroll keys; returns whether the key was used. */
  key(name: string, ctrl?: boolean): boolean {
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
const VERBS: Record<string, string> = { read_file: "Reading", list_files: "Listing", grep: "Searching", write_file: "Writing", edit_file: "Editing", sh: "Running", web_search: "Searching the web for", fetch_url: "Fetching", task: "Delegating", memory_save: "Saving note", memory_search: "Recalling", todo_write: "Planning" };
/** "Reading src/app.ts": what a tool call is doing, for the status line and the run panel. */
export function toolVerb(name: string, args: string, past = false): string {
  const a = argSummary(name, args), v = VERBS[name] ?? toolLabel(name);
  return past ? `${toolLabel(name)} ${a}`.trim() : `${v} ${a}`.trim();
}
const shortPath = (p: string) => { const h = process.env.HOME ?? ""; return h && p.startsWith(h) ? "~" + p.slice(h.length) : p; };
function ago(iso: string) { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; }
void InputOverlay; void ITAL; void BOLD; void split; void estimateCost; void ({} as Cell);

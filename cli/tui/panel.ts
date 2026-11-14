// What the side panel shows, computed once from the App for every front end: the full-screen terminal sidebar draws it with cells, the desktop app with HTML.
// A front end keeps its own PanelState (which loop steps the user opened, a cache of the context map); everything else comes from the App.
import type { App } from "./app.ts";
import type { Block } from "./blocks.ts";
import type { LoopData } from "./looppanel.ts";
import { estimateCost } from "./pricing.ts";
import type { SidebarData } from "./sidebar.ts";
import { TIPS } from "./theme.ts";
import type { Theme } from "./themes.ts";
import { contextMap } from "./tokens.ts";
import { argSummary, toolLabel } from "./view.ts";

const VERBS: Record<string, string> = { read_file: "Reading", list_files: "Listing", grep: "Searching", write_file: "Writing", edit_file: "Editing", sh: "Running", web_search: "Searching the web for", fetch_url: "Fetching", task: "Delegating", memory_save: "Saving note", memory_search: "Recalling", todo_write: "Planning" };
/** "Reading src/app.ts": what a tool call is doing, for the status line and the run panel. */
export function toolVerb(name: string, args: string, past = false): string {
  const a = argSummary(name, args), v = VERBS[name] ?? toolLabel(name);
  return past ? `${toolLabel(name)} ${a}`.trim() : `${v} ${a}`.trim();
}
export const shortPath = (p: string) => { const h = process.env.HOME ?? ""; return h && p.startsWith(h) ? "~" + p.slice(h.length) : p; };

export type PanelState = { openSteps: Set<number>; openFor: number; ctxCache?: { key: string; map: SidebarData["map"] }; startedAt: number; tipIdx: number };
export const newPanelState = (): PanelState => ({ openSteps: new Set(), openFor: 0, startedAt: Date.now(), tipIdx: Math.floor(Math.random() * TIPS.length) });
export function toggleStep(st: PanelState, step: number) { if (st.openSteps.has(step)) st.openSteps.delete(step); else st.openSteps.add(step); }

/** The agent loop of the current (or last) run, step by step. */
export function loopData(app: App, st: PanelState, now: number): LoopData | undefined {
  const steps = app.trace.filter((s) => s.t0 >= app.runStart - 50);   // this run's steps (the trace spans the whole session)
  if (!steps.length) return undefined;
  if (st.openFor !== app.runStart) { st.openFor = app.runStart; st.openSteps.clear(); }   // step numbers start again in a new run
  return { live: app.running, phase: app.phase?.phase ?? "model", cap: app.phase?.max ?? 30, now, frame: app.frame, steps,
    elapsedMs: app.running ? now - app.runStart : Math.max(...steps.map((s) => s.t0 + s.ms)) - app.runStart,
    inflight: [...app.inflight.values()].map((x) => ({ label: toolVerb(x.name, x.args), ms: now - x.t0, agent: x.agent, name: x.name, args: x.args })),
    open: app.running ? [...new Set([...st.openSteps, steps[steps.length - 1].n])] : [...st.openSteps] };   // the step happening now shows its details; finished ones fold unless you opened them
}

/** Everything the side panel shows. `t` only colours the context map. */
export function sidebarData(app: App, st: PanelState, t: Theme, now: number): SidebarData {
  const u = app.session.usage, win = app.window, mkey = `${app.session.messages.length}|${app.lastPrompt}|${t.name}`;
  if (st.ctxCache?.key !== mkey) {
    const m = contextMap(app.session.messages, app.lastPrompt, JSON.stringify(app.agent.registry.visible({ step: 0, messages: [] }).map((x) => x.name + x.description)).length);
    const tot = Math.max(1, m.total), cols: Record<string, number> = { tools: t.tool.read, assistant: t.tool.edit, you: t.ok, system: t.accent, defs: t.accent2 };
    st.ctxCache = { key: mkey, map: m.parts.map((p) => ({ label: p.label, pct: Math.round((p.tokens / tot) * 100), color: cols[p.key] })).sort((a, b) => b.pct - a.pct) };
  }
  const changes = new Map<string, SidebarData["changes"][number]>();
  for (const b of app.blocks.blocks) if (b.kind === "tool" && b.edit) { const p = changes.get(b.edit.path); changes.set(b.edit.path, { path: b.edit.path, added: (p?.added ?? 0) + b.edit.added, removed: (p?.removed ?? 0) + b.edit.removed, created: p?.created ?? b.edit.created, blockId: b.id }); }
  return {
    title: app.session.title, model: app.cfg.model, provider: app.cfg.provider, api: app.model.api?.(), branch: app.branch, cwd: shortPath(app.cwd), mode: app.mode, effort: app.cfg.effort, roles: app.wired?.labels,
    skills: (app.agent.allSkills ?? []).map((s) => ({ name: s.name, uses: app.skillsUsed.get(s.name) ?? 0, off: app.agent.skillState.isOff(s.name) })),
    pluginStatus: app.pluginStatus(), budget: { used: Math.round(app.budget.effective), max: app.budget.maxTokens }, ctxPct: app.ctxPct, ctxUsed: app.lastPrompt, ctxMax: win, series: u.series ?? [], requests: (u.requests ?? []).map((r) => ({ ...r, cost: estimateCost(app.cfg.model, r.prompt, r.completion, r.cached) })), map: st.ctxCache.map,
    usage: { prompt: u.prompt, completion: u.completion, calls: u.calls, cached: u.cached ?? 0, reasoning: u.reasoning ?? 0 }, cost: estimateCost(app.cfg.model, u.prompt, u.completion, u.cached ?? 0),
    todos: app.todos, changes: [...changes.values()].reverse(), tools: app.agent.registry.visible({ step: 0, messages: [] }).length, mcp: app.mcp.length + (app.mcpHub?.rows().filter((r) => r.status === "connected").length ?? 0), memory: app.memory?.list().length ?? 0,
    sandbox: app.cfg.sandbox,
    tasks: app.bg?.tasks.map((x) => ({ id: x.id, task: x.task.replace(/\s+/g, " "), status: x.status, secs: Math.round(((x.ended ?? now) - x.started) / 1000), changed: x.changed?.length ?? 0 })),
    procs: app.agent.procs?.list().map((p) => ({ id: p.id, name: p.name, status: p.status, secs: Math.round((now - p.startedAt) / 1000) })),
    running: app.running, elapsedMs: now - st.startedAt, tip: TIPS[st.tipIdx], lastTurnCost: app.lastTurnCost,
    agents: app.blocks.blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool" && b.name === "task" && b.status === "running").map((b) => {
      const kids = app.blocks.kids(b.callId), last = kids.at(-1); let task = ""; try { task = String(JSON.parse(b.args).description ?? ""); } catch { /* partial args */ }
      return { task: task.replace(/\s+/g, " "), doing: last ? toolVerb(last.name, last.args, last.status !== "running") : "starting", steps: kids.length, secs: Math.round((now - b.t0) / 1000) };
    }),
    loop: loopData(app, st, now),
  };
}

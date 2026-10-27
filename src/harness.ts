import { type Schema, validate, parseLooseJson } from "./schema.ts";

export type ToolCall = { id: string; type?: "function"; function: { name: string; arguments: string } };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; /** part of the prompt served from the provider's cache */ cached_tokens?: number; /** part of the output spent on hidden reasoning */ reasoning_tokens?: number };
export type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; usage?: Usage;
  /** Provider-native content blocks (e.g. Claude thinking blocks). Kept verbatim in history and handed back to the adapter. */
  raw?: unknown };
export type ToolSpec = { name: string; description: string; parameters: Schema };
/** Any chat model: messages + tool specs in, assistant message out (attach `usage` if known). See openai.ts. */
export type ModelOpts = { signal?: AbortSignal; /** Cap on generated tokens for this call (used for cache keep-alive pings; adapters may ignore it). */ maxTokens?: number; /** Called with each piece of assistant text as it is generated (streaming adapters only). */ onText?: (delta: string) => void; /** Called with pieces of the model's reasoning summary, where the provider exposes one. */ onThinking?: (delta: string) => void };
export type Model = ((messages: Message[], tools: ToolSpec[], opts?: ModelOpts) => Promise<Message>) & {
  /** Set by adapters whose provider binds reasoning to the exact history (Claude): the harness then never edits past turns. */
  appendOnly?: boolean;
  /** Which wire API the adapter is using right now (e.g. "responses" / "chat"); adapters may change it at runtime. */
  api?: () => string;
};

export type ToolCtx = { registry: Registry; step: number; /** Aborted when the run is interrupted; long-running tools should honour it. */ signal?: AbortSignal; /** Publish a custom event (e.g. a live file diff) to `onEvent`. */ emit?: (e: Event) => void };
export type Tool<A = any> = {
  name: string; description: string; schema: Schema; run: (args: A, ctx: ToolCtx) => unknown | Promise<unknown>;
  /** Hidden from the model until it finds it via `tool_search` (keeps prompts small when you have many tools). */
  deferred?: boolean;
  /** Availability per turn; the tool is only shown (and callable) while this returns true. */
  when?: (s: { step: number; messages: Message[] }) => boolean;
  /** Needs human approval before running. A function may return true, or a string reason, to flag a specific call. */
  risky?: boolean | ((args: A) => boolean | string);
  /** Human-readable preview of what this call will do (a diff, a command), shown in the approval prompt. */
  preview?: (args: A) => string | undefined;
  /** Never changes anything (safe in plan mode, safe to run in a read-only subagent). */
  readOnly?: boolean;
  /** Safe to run at the same time as other calls even though it is not read-only (e.g. a subagent working in its own context). Everything else runs one at a time, in call order. */
  parallel?: boolean;
};
export const defineTool = <A = any>(t: Tool<A>) => t;

/** The live set of tools. Mutate it between or during runs (tools receive it as `ctx.registry`); changes show up next turn. */
export class Registry {
  tools = new Map<string, Tool>(); loaded = new Set<string>();
  constructor(ts: Tool[] = []) { this.add(...ts); }
  add(...ts: Tool[]) { for (const t of ts) this.tools.set(t.name, t); return this; }
  remove(name: string) { this.loaded.delete(name); return this.tools.delete(name); }
  get(name: string) { return this.tools.get(name); }
  hasDeferred() { return [...this.tools.values()].some((t) => t.deferred); }
  visible(s: { step: number; messages: Message[] }) {
    return [...this.tools.values()].filter((t) => (!t.deferred || this.loaded.has(t.name)) && (!t.when || t.when(s)));
  }
  /** Keyword-rank the not-yet-loaded deferred tools by name + description. */
  search(q: string, n = 5) {
    const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    return [...this.tools.values()].filter((t) => t.deferred && !this.loaded.has(t.name))
      .map((t) => ({ t, score: words.filter((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name)).slice(0, n).map((x) => x.t);
  }
}

export type Event =
  | { kind: "toolstart"; id: string; name: string; args: string }
  | { kind: "tool"; id?: string; name: string; args: string; result: string }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "assistant"; text: string; streamed: boolean }
  | { kind: "todos"; todos: { content: string; status: "pending" | "in_progress" | "done" }[] }
  | { kind: "steer"; text: string }
  | { kind: "nudge" | "loop" | "rejected" | "repair" | "denied" | "budget" | "tools" | "aborted"; detail: string }
  | { kind: "edit"; path: string; created: boolean; added: number; removed: number; diff: string; /** File content before the edit (null = it did not exist); lets a UI offer undo. */ before?: string | null }
  | { kind: "turn"; step: number; tokens: number; prompt: number; completion: number; cached: number; reasoning: number }
  | { kind: "rollover"; detail: string }
  /** Context that was shrunk without losing anything current (chars; roughly 4 per token). */
  | { kind: "trim"; saved: number; what: string }
  /** The request prefix changed since the last call, so the provider's prompt cache will miss from `at` onward (message index; -1 = tool definitions). */
  | { kind: "cachebreak"; reason: string; at: number }
  /** Where the loop is: lets a UI show live progress. `step` is 0-based; `n` is the number of tool calls in the batch. */
  | { kind: "phase"; phase: "model" | "tools" | "verify" | "compact"; step: number; max: number; n?: number }
  | { kind: "finish"; summary: string };

/** Shared token/time cap. Pass one instance to a harness (and its subagents) to bound the whole run. */
export class Budget {
  tokens = 0; promptTokens = 0; completionTokens = 0; /** prompt tokens the provider served from its cache */ cachedTokens = 0; calls = 0; t0 = Date.now(); maxTokens: number; maxMs: number;
  constructor(o: { maxTokens?: number; maxMs?: number } = {}) { this.maxTokens = o.maxTokens ?? Infinity; this.maxMs = o.maxMs ?? Infinity; }
  add(m: Message) { this.calls++; this.promptTokens += m.usage?.prompt_tokens ?? 0; this.completionTokens += m.usage?.completion_tokens ?? 0; this.cachedTokens += m.usage?.cached_tokens ?? 0; this.tokens += m.usage?.total_tokens ?? (m.usage ? (m.usage.prompt_tokens ?? 0) + (m.usage.completion_tokens ?? 0) : 0); }
  get ms() { return Date.now() - this.t0; }
  exceeded(): string | null {
    return this.tokens >= this.maxTokens ? `token budget exhausted (${this.tokens}/${this.maxTokens})`
      : this.ms >= this.maxMs ? `time budget exhausted (${Math.round(this.ms / 1000)}s)` : null;
  }
}

export type Approve = (req: { name: string; args: any; reason?: string; preview?: string; id?: string }) => Promise<boolean | string> | boolean | string;
/** Turn-off switches, mainly so evals can measure what each guard is worth. */
export type Guard = "nudge" | "loop" | "compact" | "stuck" | "wrapup" | "condense" | "schedule";

export type Options = {
  model: Model;
  /** A fixed list, or a live Registry you can add to / remove from at any time. */
  tools?: Tool[] | Registry;
  system?: string;
  /** Gate for `finish`: return true/undefined to accept, or a string / {ok:false, feedback} to reject with feedback. */
  verify?: (summary: string) => Promise<true | string | void | { ok: boolean; feedback?: string }> | true | string | void;
  maxSteps?: number;
  /** Chars of transcript before old tool output is elided. */
  contextBudget?: number;
  budget?: Budget;
  /** Asked before any `risky` tool call. Return true to allow, or false / a string (shown to the model) to deny. No handler = deny. */
  approve?: Approve;
  /** Called at the start of every turn with the full transcript; persist it to resume after a crash or pause. */
  checkpoint?: (messages: Message[]) => void;
  off?: Guard[];
  /**
   * Long-run memory management without editing history: when the context passes a threshold, the model writes a handoff
   * note and the run continues in a fresh context seeded with the task + that note. Works for every provider.
   */
  rollover?: { afterTokens?: number; afterChars?: number };
  /** Receives each handoff note (persist it; it is also a portable summary of the work so far). */
  onHandoff?: (note: string) => void;
  /** Interrupt the run: it stops at the next safe point (history stays consistent, so it can be resumed). */
  signal?: AbortSignal | (() => AbortSignal | undefined);
  /** Polled at the start of every turn: messages the user typed while the agent was working ("steering"). They join the conversation immediately. */
  inbox?: () => string[];
  onEvent?: (e: Event) => void;
};

export const HANDOFF_PROMPT = `Your context is about to be reset. Write a handoff note for yourself; you will continue from it with no other memory of this session. Do not call tools; reply with the note only (under 500 words), in this shape:
GOAL: what the user wants, in your own words
DONE: what is finished, with exact file paths and decisions made
STATE: what you verified (commands run, results), what is still failing
NEXT: the concrete next steps, in order
GOTCHAS: facts learned the hard way (commands, quirks, dead ends not to repeat)`;

/** Ask the model to summarise the transcript so far. Tool specs are passed because some APIs require them when history contains tool calls. */
export async function makeHandoff(model: Model, specs: ToolSpec[], msgs: Message[], budget?: Budget): Promise<string> {
  const m = await model([...msgs, { role: "user", content: HANDOFF_PROMPT }], specs);
  budget?.add(m);
  return (m.content ?? "").trim() || "(no handoff was produced; inspect the workspace to see what has been done)";
}
const HANDOFF_MARK = "\n\n## Handoff from your earlier context";

export type RunResult = { text: string; finished: boolean; steps: number; messages: Message[]; stopped?: "budget" | "maxSteps" | "aborted" | "stuck"; tokens: number };

export const DEFAULT_SYSTEM = `You are an autonomous agent. Work until the task is DONE, then call \`finish\`.
- Act, don't narrate. If you say you will do something, do it in the same turn with a tool call.
- Don't ask permission or clarification unless truly blocked; choose a sensible default and state it in \`finish\`.
- Never invent tool output, data or identifiers. If unsure, check with a tool.
- Verify your work before finishing. Only call \`finish\` when verified.
- If an approach fails twice, change approach instead of repeating it.
- Tool errors are information: read them, fix your call, retry.
- \`finish(summary)\`: what you did, how you verified, assumptions made.`;

const FINISH: ToolSpec = {
  name: "finish", description: "Declare the task complete. Only call after verifying.",
  parameters: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
};
const INTENT = /\b(i'll|i will|let me(?! know)|next,? i|now i|i am going to|i'm going to)\b/i;

export const clip = (s: string, n = 6000) =>
  s.length <= n ? s : `${s.slice(0, (n * 2) / 3)}\n...[${s.length - n} chars cut]...\n${s.slice(-n / 3)}`;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SIGNAL = /error|fail|warn|exception|assert|panic|traceback|✗|expected|actual|cannot|not found|denied/i;
/**
 * Shrink a tool observation before it enters the transcript, keeping what the next action depends on
 * (CoACT's "action-preserving" rule, done with rules instead of a trained compressor): strip terminal control codes and
 * progress-bar redraws, collapse repeated lines, and when still too long keep head and tail plus the error-looking lines from the middle.
 */
export function condense(s: string, max = 6000): string {
  let t = s.replace(ANSI, "");
  if (t.includes("\r")) t = t.split("\n").map((l) => (l.includes("\r") ? l.split("\r").filter(Boolean).pop() ?? "" : l)).join("\n");
  const lines = t.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1; while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (!lines[i].trim() || n <= 2) out.push(...lines.slice(i, j)); else out.push(lines[i], `  … previous line repeated ${n - 1} more times`);
    i = j;
  }
  t = out.join("\n").replace(/\n{4,}/g, "\n\n\n");
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.4)), tail = t.slice(t.length - Math.floor(max * 0.3)), mid = t.slice(head.length, t.length - tail.length);
  const sig = mid.split("\n").filter((l) => SIGNAL.test(l)).map((l) => l.slice(0, 200)).slice(0, 25).join("\n");
  return `${head}\n...[${mid.length} chars cut${sig ? "; the error/warning lines from the cut part follow" : ""}]...\n${sig ? sig + "\n...\n" : ""}${tail}`;
}

/** Same call repeated later in the transcript: the older output is stale, so drop it first (cheapest compaction, loses nothing current). */
export function supersede(msgs: Message[], keep = 6, isRead?: (tool: string) => boolean): number {
  const calls = new Map<string, { key: string; name: string; path?: string }>(), latest = new Map<string, string>();
  for (const m of msgs) for (const c of m.tool_calls ?? []) {
    let path: string | undefined; try { const p = JSON.parse(c.function.arguments || "{}").path; if (typeof p === "string") path = p; } catch { /* not JSON: no path */ }
    const key = c.function.name + c.function.arguments; calls.set(c.id, { key, name: c.function.name, path }); latest.set(key, c.id);
  }
  // "Expired" reads (AgentDiet): a read of a file that was edited afterwards no longer describes the file.
  const editedAt = new Map<string, number>();
  if (isRead) msgs.forEach((m, i) => { const c = m.role === "tool" && m.tool_call_id ? calls.get(m.tool_call_id) : undefined; if (c?.path && !isRead(c.name) && !/^(ERROR|DENIED|REJECTED)/.test(m.content ?? "")) editedAt.set(c.path, i); });
  let saved = 0;
  msgs.slice(0, -keep).forEach((m, i) => {
    const c = m.role === "tool" && m.tool_call_id ? calls.get(m.tool_call_id) : undefined;
    if (!c || (m.content?.length ?? 0) <= 200 || m.content!.startsWith("[")) return;
    const stale = c.path !== undefined && isRead?.(c.name) && (editedAt.get(c.path) ?? -1) > i;
    const note = stale ? "[stale: this file was edited afterwards; read it again if you need the current contents]" : latest.get(c.key) !== m.tool_call_id ? "[superseded: this call was repeated later; see the newer result]" : "";
    if (note) { saved += m.content!.length - note.length; m.content = note; }
  });
  return saved;
}

/** Elide old tool outputs once the transcript passes `budget` chars; the last `keep` messages stay intact. */
export function compact(msgs: Message[], budget = 60_000, keep = 6): number {
  let total = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  if (total <= budget) return 0;
  // Hysteresis: once over budget, cut well below it in one go. Every edit to old messages breaks the provider's prompt-cache prefix, so do it rarely.
  const target = budget * 0.7, start = total;
  for (const m of msgs.slice(0, -keep)) {
    if (total <= target) break;
    if (m.role === "tool" && (m.content?.length ?? 0) > 300) {
      const old = m.content!.length;
      m.content = `[old output elided, ${old} chars; call the tool again if you need it]`;
      total -= old - m.content.length;
    }
  }
  return start - total;
}

type PrefixSig = { tools: string; msgs: string[] };
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length.toString(36); };
/** Cheap fingerprint of what the provider caches: the tool definitions, then each message in order. */
export const prefixSignature = (msgs: Message[], specs: ToolSpec[]): PrefixSig => ({ tools: fnv(JSON.stringify(specs)), msgs: msgs.map((m) => fnv((m.content ?? "") + (m.tool_calls ? JSON.stringify(m.tool_calls) : "") + (m.tool_call_id ?? ""))) });
/** Where (and why) this request stops matching the previous one. Pure appends return undefined: that is the cache-friendly case. */
export function firstCacheBreak(prev: PrefixSig | undefined, now: PrefixSig): { reason: string; at: number } | undefined {
  if (!prev) return undefined;
  if (prev.tools !== now.tools) return { reason: "the tool list changed (mode switch or a tool was loaded), which invalidates the whole cache", at: -1 };
  for (let i = 0; i < Math.min(prev.msgs.length, now.msgs.length); i++) if (prev.msgs[i] !== now.msgs[i]) return { reason: `earlier history was rewritten at message ${i} (compaction, handoff or edit)`, at: i };
  return now.msgs.length < prev.msgs.length ? { reason: "history was shortened (handoff or rewind)", at: now.msgs.length } : undefined;
}
const MAX_PARALLEL = 5;
const isErr = (r: string) => /^(ERROR|DENIED|REJECTED)\b/.test(r);
/** Run `fns` with at most `n` in flight; results keep input order. */
async function pool<T>(fns: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out = new Array<T>(fns.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => { while (next < fns.length) { const i = next++; out[i] = await fns[i](); } }));
  return out;
}

const feedback = (v: Awaited<ReturnType<NonNullable<Options["verify"]>>>): string | null =>
  v === true || v === undefined ? null : typeof v === "string" ? v : v.ok ? null : v.feedback ?? "verification failed";

export function createHarness(o: Options) {
  const reg = o.tools instanceof Registry ? o.tools : new Registry(o.tools);
  const spec = (t: Tool): ToolSpec => ({ name: t.name, description: t.description, parameters: t.schema });
  const searchTool: Tool<{ query: string }> = {
    name: "tool_search", description: "", schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    run: ({ query }) => {
      const hits = reg.search(query);
      hits.forEach((t) => reg.loaded.add(t.name));
      return hits.length ? "Loaded (callable from your next turn):\n" + hits.map((t) => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.schema)}`).join("\n")
        : `No match. Not yet loaded: ${[...reg.tools.values()].filter((t) => t.deferred && !reg.loaded.has(t.name)).map((t) => t.name).join(", ") || "(none)"}`;
    },
  };
  const emit = (e: Event) => o.onEvent?.(e);
  const off = new Set(o.off ?? []);
  const sig = () => (typeof o.signal === "function" ? o.signal() : o.signal);
  let approvals: Promise<unknown> = Promise.resolve(); // serialise prompts so parallel calls don't interleave questions

  let lastStep = 0;
  /**
   * Re-send the conversation with a tiny output cap so the provider keeps the cached prefix alive during an idle gap (it costs a cache READ of
   * the prefix, a fraction of what a cold re-read costs). Returns how many prompt tokens were served from cache.
   */
  async function warm(msgs: Message[], opts: { signal?: AbortSignal } = {}): Promise<{ prompt: number; cached: number }> {
    const visible = reg.visible({ step: lastStep, messages: msgs }), menu = reg.hasDeferred() ? [...reg.tools.values()].filter((t) => t.deferred && !reg.loaded.has(t.name)) : [];
    const specs = [...visible.map(spec).sort((a, b) => (a.name < b.name ? -1 : 1)), ...(menu.length ? [{ ...spec(searchTool), description: "Load more tools by keyword before using them. Not yet loaded:\n" + menu.map((t) => `- ${t.name}: ${t.description.slice(0, 80)}`).join("\n") }] : []), FINISH];
    const m = await o.model(msgs, specs, { signal: opts.signal, maxTokens: 16 });
    o.budget?.add(m);
    return { prompt: m.usage?.prompt_tokens ?? 0, cached: m.usage?.cached_tokens ?? 0 };
  }

  /** Agent loop. Resolves with the model's final answer (`finish` summary or accepted plain-text reply). */
  async function run(task: string, opts: { resume?: Message[] } = {}): Promise<RunResult> {
    const msgs: Message[] = opts.resume ? [...opts.resume] : [{ role: "system", content: o.system ?? DEFAULT_SYSTEM }, { role: "user", content: task }];
    const seen = new Map<string, number>();
    const max = o.maxSteps ?? 30;
    let sent: PrefixSig | undefined, ingress = 0, nudges = 0, tokens = 0, shown = "", lastPrompt = 0, failStreak = 0, warned = false, reflected = false;
    const end = (text: string, finished: boolean, steps: number, stopped?: RunResult["stopped"]): RunResult => ({ text, finished, steps, messages: msgs, stopped, tokens });

    for (let step = 0; step < max; step++) {
      lastStep = step;
      if (sig()?.aborted) { o.checkpoint?.(msgs); emit({ kind: "aborted", detail: "interrupted" }); return end("stopped: interrupted", false, step, "aborted"); }
      for (const text of o.inbox?.() ?? []) { msgs.push({ role: "user", content: text }); emit({ kind: "steer", text }); }
      const over = o.budget?.exceeded();
      if (over) { emit({ kind: "budget", detail: over }); return end(`stopped: ${over}`, false, step, "budget"); }
      const visible = reg.visible({ step, messages: msgs }), names = new Set(visible.map((t) => t.name));
      const menu = reg.hasDeferred() ? [...reg.tools.values()].filter((t) => t.deferred && !reg.loaded.has(t.name)) : [];
      const specs = [...visible.map(spec).sort((a, b) => (a.name < b.name ? -1 : 1)), ...(menu.length ? [{ ...spec(searchTool), description: "Load more tools by keyword before using them. Not yet loaded:\n" + menu.map((t) => `- ${t.name}: ${t.description.slice(0, 80)}`).join("\n") }] : []), FINISH];
      const r = o.rollover, size = msgs.reduce((n, x) => n + (x.content?.length ?? 0), 0);
      if (r && step > 0 && (lastPrompt >= (r.afterTokens ?? Infinity) || size >= (r.afterChars ?? Infinity))) {
        const note = await makeHandoff(o.model, specs, msgs, o.budget);
        const first = (msgs.find((x) => x.role === "user")?.content ?? "").split(HANDOFF_MARK)[0];
        msgs.splice(1, msgs.length, { role: "user", content: `${first}${HANDOFF_MARK} (you are continuing, not starting over)\n${note}` });
        seen.clear(); nudges = 0; lastPrompt = 0;
        o.onHandoff?.(note); emit({ kind: "rollover", detail: note.slice(0, 200) });
      }
      if (!off.has("wrapup") && !warned && max > 6 && step === max - 3) {
        warned = true; emit({ kind: "nudge", detail: "step limit near" });
        msgs.push({ role: "user", content: `You have 3 steps left. Stop exploring: finish the most important remaining work, verify it, and call \`finish\` with what is done and what is not.` });
      }
      o.checkpoint?.(msgs);
      emit({ kind: "phase", phase: "compact", step, max });
      // Editing old messages breaks the provider's prompt-cache prefix from that point on, and cached input is ~10x cheaper than fresh input,
      // so history is only rewritten when the window needs it, and then all stages at once (one break), cutting well below the budget (hysteresis).
      if (!off.has("compact") && !o.model.appendOnly && msgs.reduce((n, x) => n + (x.content?.length ?? 0), 0) > (o.contextBudget ?? 60_000)) {
        const s = supersede(msgs, 6, (n) => reg.get(n)?.readOnly === true) + compact(msgs, o.contextBudget);
        if (s > 0) emit({ kind: "trim", saved: s, what: "stale tool output" });
      }
      const key = [...names].sort().join(",");
      if (step > 0 && key !== shown) emit({ kind: "tools", detail: key });
      shown = key;
      { const sig = prefixSignature(msgs, specs), brk = firstCacheBreak(sent, sig); sent = sig; if (brk) emit({ kind: "cachebreak", ...brk }); }
      emit({ kind: "phase", phase: "model", step, max });
      let m: Message;
      let streamed = false;
      try { m = await o.model(msgs, specs, { signal: sig(), onText: (delta) => { streamed = true; emit({ kind: "text", delta }); }, onThinking: (delta) => emit({ kind: "thinking", delta }) }); }
      catch (e) {
        if (sig()?.aborted) { o.checkpoint?.(msgs); emit({ kind: "aborted", detail: "interrupted" }); return end("stopped: interrupted", false, step, "aborted"); }
        throw e;
      }
      o.budget?.add(m); tokens += m.usage?.total_tokens ?? 0; lastPrompt = m.usage?.prompt_tokens ?? 0;
      emit({ kind: "turn", step, tokens, prompt: m.usage?.prompt_tokens ?? 0, completion: m.usage?.completion_tokens ?? 0, cached: m.usage?.cached_tokens ?? 0, reasoning: m.usage?.reasoning_tokens ?? 0 });
      if (m.content?.trim()) emit({ kind: "assistant", text: m.content, streamed });
      msgs.push({ role: "assistant", content: m.content ?? null, ...(m.tool_calls?.length && { tool_calls: m.tool_calls }), ...(m.raw !== undefined && { raw: m.raw }) });
      if (!m.tool_calls?.length) {
        const text = (m.content ?? "").trim();
        if (!off.has("nudge") && nudges < 2 && (!text || INTENT.test(text.slice(-200)))) {
          nudges++;
          emit({ kind: "nudge", detail: text.slice(-100) });
          msgs.push({ role: "user", content: "Don't stop to describe. Do it now with a tool call, or call `finish` if truly done." });
          continue;
        }
        return end(text, false, step + 1);
      }
      // Scheduling: runs of read-only / parallel-safe calls (reads, searches, subagents) go concurrently, up to MAX_PARALLEL;
      // anything that may change state runs alone, in the order the model issued it. Results keep call order.
      let done: string | undefined;
      emit({ kind: "phase", phase: "tools", step, max, n: m.tool_calls.length });
      const exec = async (c: ToolCall): Promise<string> => {
        const { name, arguments: raw } = c.function;
        let args: any;
        try { args = JSON.parse(raw || "{}"); } catch (e) { return `ERROR: arguments were not valid JSON (${(e as Error).message}). Resend strict JSON.`; }
        const t = name === "tool_search" && menu.length ? searchTool : reg.get(name);
        if (t && name !== "finish" && t !== searchTool && !names.has(name)) {
          if (t.deferred && !reg.loaded.has(name)) { reg.loaded.add(name); return `ERROR: ${name} was not loaded yet; it is now. Retry the call. schema: ${JSON.stringify(t.schema)}`; }
          return `ERROR: tool ${name} is not available right now. Available: ${[...names, "finish"].join(", ")}`;
        }
        const schema = name === "finish" ? FINISH.parameters : t?.schema;
        const errs = schema ? validate(args, schema) : [`unknown tool "${name}". Available: ${[...names, "finish"].join(", ")}`];
        if (errs.length) { emit({ kind: "repair", detail: errs.join("; ") }); return `ERROR: ${errs.join("; ")}`; }
        if (name === "finish") {
          if (o.verify) emit({ kind: "phase", phase: "verify", step, max });
          const fb = feedback(await o.verify?.(args.summary));
          if (!fb) { done = args.summary; emit({ kind: "finish", summary: args.summary }); return "accepted"; }
          emit({ kind: "rejected", detail: fb });
          return `REJECTED: ${clip(fb, 3000)}\nFix the problem, then finish again.`;
        }
        const key = name + raw;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 2 && !off.has("loop")) { emit({ kind: "loop", detail: key.slice(0, 100) }); return `ERROR: you've made this exact call ${n} times. Do something different.`; }
        const risk = typeof t!.risky === "function" ? t!.risky(args) : t!.risky;
        if (risk) {
          let preview: string | undefined;
          try { preview = t!.preview?.(args); } catch { /* a broken preview must not block the prompt */ }
          const ask = approvals.then(() => o.approve?.({ name, args, reason: typeof risk === "string" ? risk : undefined, preview, id: c.id }) ?? false);
          approvals = ask.catch(() => {});
          const ok = await ask;
          if (ok !== true) {
            const why = typeof ok === "string" ? ok : "not approved";
            emit({ kind: "denied", detail: `${name}: ${why}` });
            return `DENIED: ${why}. Do not retry this; choose a safer alternative, or finish and explain what you could not do.`;
          }
        }
        let result: string;
        emit({ kind: "toolstart", id: c.id, name, args: raw });
        try { const r = await t!.run(args, { registry: reg, step, emit, signal: sig() }); const raw = typeof r === "string" ? r : JSON.stringify(r) ?? "ok"; result = off.has("condense") ? clip(raw) : condense(raw); ingress += raw.length - result.length; }
        catch (e) { result = `ERROR: ${(e as Error).message}`; }
        emit({ kind: "tool", id: c.id, name, args: raw, result });
        return result;
      };
      const safe = (c: ToolCall) => { if (off.has("schedule")) return false; const t = reg.get(c.function.name); return !t || t.readOnly === true || t.parallel === true; };
      const results: string[] = [];
      for (let i = 0; i < m.tool_calls.length; ) {
        let j = i; while (j < m.tool_calls.length && safe(m.tool_calls[j]) === safe(m.tool_calls[i])) j++;
        const batch = m.tool_calls.slice(i, j);
        results.push(...(safe(batch[0]) ? await pool(batch.map((c) => () => exec(c)), MAX_PARALLEL) : await pool(batch.map((c) => () => exec(c)), 1)));
        i = j;
      }
      if (ingress > 300) { emit({ kind: "trim", saved: ingress, what: "tool output condensed" }); } ingress = 0;
      m.tool_calls.forEach((c, i) => msgs.push({ role: "tool", tool_call_id: c.id, content: results[i] }));
      if (done !== undefined) return end(done, true, step + 1);
      // No-progress detection: every call this turn failed. Reflect once, then stop instead of burning the budget.
      if (!off.has("stuck")) {
        failStreak = results.every(isErr) ? failStreak + 1 : 0;
        if (failStreak >= 3 && !reflected) {
          reflected = true; emit({ kind: "nudge", detail: "stuck: reflecting" });
          msgs.push({ role: "user", content: "Your last 3 turns all failed. Stop and reflect: what is the actual cause? Re-read the errors, check your assumptions with a read-only tool, and take a different approach, or call `finish` and explain what blocks you." });
        } else if (failStreak >= 6) { emit({ kind: "loop", detail: "no progress: 6 failing turns in a row" }); o.checkpoint?.(msgs); return end("stopped: no progress (6 failing turns in a row)", false, step + 1, "stuck"); }
      }
    }
    return end("stopped: maxSteps reached", false, max, "maxSteps");
  }

  /** One-shot structured output: ask for JSON, validate against `schema`, feed errors back until it conforms. */
  async function extract<T = unknown>(prompt: string, schema: Schema, attempts = 3): Promise<T> {
    const msgs: Message[] = [
      { role: "system", content: `${o.system ?? "You are a precise assistant."}\nReply with ONLY a JSON value matching this JSON schema, no prose:\n${JSON.stringify(schema)}` },
      { role: "user", content: prompt },
    ];
    let last = "";
    for (let i = 0; i < attempts; i++) {
      const m = await o.model(msgs, []);
      o.budget?.add(m);
      const text = m.content ?? "";
      msgs.push({ role: "assistant", content: text });
      try {
        const v = parseLooseJson(text);
        const errs = validate(v, schema);
        if (!errs.length) return v as T;
        last = errs.join("; ");
      } catch (e) { last = (e as Error).message; }
      emit({ kind: "repair", detail: last });
      msgs.push({ role: "user", content: `Invalid: ${last}. Reply again with ONLY corrected JSON.` });
    }
    throw new Error(`extract failed after ${attempts} attempts: ${last}`);
  }

  return { run, extract, warm };
}

// Per-step model routing that prices the prompt cache. Exploring (reading files, searching) rarely needs the strongest model; planning, editing and recovering from failures do.
// But every model has its OWN prompt cache, so switching costs a cold read of the whole conversation on the new model. A router that ignores that can spend more than it saves:
// it only moves to the cheap model when the exploration streak is long enough (or the cheap cache is still warm) that the cheaper steps repay the cold read.
import type { Message, Model, ModelOpts, ToolSpec } from "./harness.ts";

export type Tier = "strong" | "cheap";
export type Prices = { /** dollars (or any unit) per million input tokens */ input: number; output: number; /** fraction of the input price charged for cached input (default 0.1) */ cachedRate?: number };
export type Decision = { tier: Tier; reason: string };
export type RouterOptions = {
  strong: Model; cheap: Model; prices?: { strong: Prices; cheap: Prices };
  /** how long a provider keeps a prompt cache warm (ms); default 5 minutes */ ttlMs?: number;
  onRoute?: (d: Decision & { switched: boolean; promptTokens: number }) => void; now?: () => number;
};

const READ_ONLY = new Set(["read_file", "list_files", "grep", "repo_map", "find_refs", "impact", "skill", "sh_read", "sh_list", "memory_search", "web_search", "fetch_url", "task", "todo_write"]);
const failed = (s: string) => /^(ERROR|DENIED|REJECTED|BLOCKED)/.test(s) || /^exit=(?!0\b)/.test(s);
const tokensOf = (ms: Message[]) => Math.ceil(ms.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) / 4);

/** What the end of the conversation looks like: how many exploration-only turns in a row, and whether anything just went wrong or needs judgement. */
export function tailShape(messages: Message[]): { streak: number; trouble: boolean; first: boolean; steering: boolean } {
  const last = messages.at(-1), assistants = messages.filter((m) => m.role === "assistant");
  const steering = last?.role === "user" && assistants.length > 0;
  let streak = 0, trouble = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]; if (m.role !== "assistant") continue;
    if (!m.tool_calls?.length) break;
    const names = m.tool_calls.map((c) => c.function.name);
    if (!names.every((n) => READ_ONLY.has(n))) break;
    streak++;
  }
  // results after the last assistant message
  const lastA = messages.map((m) => m.role).lastIndexOf("assistant");
  for (const m of messages.slice(lastA + 1)) if (m.role === "tool" && failed(m.content ?? "")) trouble = true;
  if (last?.role === "user" && /\b(REJECTED|nothing measurable has improved|going in circles|reflect)\b/i.test(last.content ?? "")) trouble = true;
  return { streak, trouble, first: assistants.length === 0, steering };
}

/** The pure decision, separated so it can be tested and tuned: cheap only when the next step is likely exploration AND switching pays for itself. */
export function decide(o: { tail: ReturnType<typeof tailShape>; promptTokens: number; current: Tier; cheapWarm: boolean; prices: { strong: Prices; cheap: Prices } }): Decision {
  const { tail: t, current } = o;
  if (t.first) return { tier: "strong", reason: "first step: plan with the strong model" };
  if (t.trouble) return { tier: "strong", reason: "something just failed: escalate" };
  if (t.steering) return { tier: "strong", reason: "new instruction from the user" };
  if (t.streak === 0) return { tier: "strong", reason: "last step changed something or answered: judgement needed" };
  if (current === "cheap") return { tier: "cheap", reason: `exploration continues (streak ${t.streak}), staying on the cheap model` };
  // currently strong, tempted to go cheap: price the cold read on the cheap model against the per-step saving
  const cr = (p: Prices) => p.cachedRate ?? 0.1, N = o.promptTokens;
  const coldRead = o.cheapWarm ? 0 : N * o.prices.cheap.input * (1 - cr(o.prices.cheap));                         // extra cost of the first call (uncached input)
  const savingPerStep = N * (o.prices.strong.input * cr(o.prices.strong) - o.prices.cheap.input * cr(o.prices.cheap));  // cached-read price difference on every cheap step
  if (savingPerStep <= 0) return { tier: "strong", reason: "the cheap model is not cheaper per cached read" };
  const needed = coldRead / savingPerStep;
  return t.streak + 1 >= needed ? { tier: "cheap", reason: `exploration streak ${t.streak}: the cold read (${Math.round(coldRead)} units) is repaid in ~${needed.toFixed(1)} steps` } : { tier: "strong", reason: `streak ${t.streak} is too short to repay a cold read on the cheap model (needs ~${needed.toFixed(1)} steps)` };
}

export function routedModel(o: RouterOptions): Model {
  const prices = o.prices ?? { strong: { input: 5, output: 25 }, cheap: { input: 1, output: 5 } }, now = o.now ?? Date.now, ttl = o.ttlMs ?? 300_000;
  let current: Tier = "strong"; let cheapWarmUntil = 0; const owner = new WeakMap<object, Tier>();
  const m: Model = async (messages: Message[], tools: ToolSpec[], opts?: ModelOpts) => {
    const tail = tailShape(messages), promptTokens = tokensOf(messages);
    const d = decide({ tail, promptTokens, current, cheapWarm: now() < cheapWarmUntil, prices });
    // reasoning blobs only make sense to the model that produced them: drop the other tier's
    const clean = messages.map((x) => (x.role === "assistant" && x.raw !== undefined && owner.get(x.raw as object) !== d.tier ? { ...x, raw: undefined } : x));
    const switched = d.tier !== current; current = d.tier; o.onRoute?.({ ...d, switched, promptTokens });
    let r: Message;
    if (d.tier === "cheap") {
      r = await o.cheap(clean, tools, opts ? { signal: opts.signal } : undefined);        // not streamed: if the answer has to be redone, nothing half-shown must be left behind
      cheapWarmUntil = now() + ttl;
      const needsJudgement = !r.tool_calls?.length || r.tool_calls.some((c) => !READ_ONLY.has(c.function.name));
      if (needsJudgement) {                                                                // the cheap model reached for an edit, a command, or the final answer: that is the strong model's job
        o.onRoute?.({ tier: "strong", reason: "the cheap model proposed a change or an answer: redone by the strong model", switched: true, promptTokens });
        current = "strong"; r = await o.strong(messages.map((x) => (x.role === "assistant" && x.raw !== undefined && owner.get(x.raw as object) === "cheap" ? { ...x, raw: undefined } : x)), tools, opts);
        if (r.raw !== undefined && typeof r.raw === "object" && r.raw) owner.set(r.raw as object, "strong");
        return r;
      }
    } else r = await o.strong(clean, tools, opts);
    if (r.raw !== undefined && typeof r.raw === "object" && r.raw) owner.set(r.raw as object, d.tier);
    return r;
  };
  m.appendOnly = o.strong.appendOnly || o.cheap.appendOnly;
  if (o.strong.api) m.api = o.strong.api;
  return m;
}

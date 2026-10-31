// Keeping a long run inside the model's context window, whatever its size (8k local Qwen to 1M). Pure functions on the message list; the loop in harness.ts decides when to call them.
// The ladder, cheapest first, loses the least first: blank old tool outputs, shrink big arguments in old tool calls, drop the oldest turns. A handoff note (harness.ts) is the last step.
// Every pass works on the recent tail last: the newest turns stay word for word as long as the window allows.
import type { Message, ToolSpec } from "./harness.ts";

const CHARS_PER_TOKEN = 3.5; // code and JSON run denser than prose (about 4); a low number errs on the safe side
const charsOf = (m: Message) => (m.content?.length ?? 0) + (m.tool_calls ?? []).reduce((k, c) => k + c.function.name.length + c.function.arguments.length + 20, 0) + (m.raw !== undefined ? JSON.stringify(m.raw).length : 0) + 16;

/** Size of a request in tokens, counting what a plain text count misses: tool-call arguments, provider extras and the tool definitions. */
export const estimateTokens = (msgs: Message[], specs: ToolSpec[] = []): number => Math.ceil((msgs.reduce((n, m) => n + charsOf(m), 0) + JSON.stringify(specs).length) / CHARS_PER_TOKEN);

const OVERFLOW = /context[ _-]?(length|window|size)|maximum context|too many tokens|prompt is too long|exceeds? the (available )?context|reduce the length|n_ctx|input is too long|token limit/i;
/** A provider (OpenAI, vLLM, llama.cpp, Ollama, Anthropic, LM Studio) refusing a request because it does not fit. */
export const isOverflow = (e: unknown): boolean => OVERFLOW.test(String((e as Error)?.message ?? e));
/** The window size when the error message states it ("maximum context length is 8192 tokens", "n_ctx = 8192"). */
export function windowFromError(e: unknown): number | undefined {
  const m = /maximum context length is (\d+)|n_ctx\D{0,6}(\d{3,})|context (?:window|size|length) (?:of|is) (\d{3,})/i.exec(String((e as Error)?.message ?? e));
  const n = Number(m?.[1] ?? m?.[2] ?? m?.[3]); return n >= 512 ? n : undefined;
}

/** The token count a provider says the request had ("you requested 8472 tokens", "250000 tokens > 200000 maximum"). */
export function requestedFromError(e: unknown): number | undefined {
  const m = /requested (\d{3,}) tokens|(\d{3,}) tokens? >\s*\d{3,}|resulted in (\d{3,}) tokens|contains (\d{3,}) tokens/i.exec(String((e as Error)?.message ?? e));
  const n = Number(m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4]); return n > 0 ? n : undefined;
}
/** Our estimate is a guess; the provider's own count is the truth. The ratio of the two, kept within sane bounds, corrects every later estimate. */
export const calibration = (actual: number, estimated: number): number => (estimated > 0 && actual > 0 ? Math.min(2.5, Math.max(0.6, actual / estimated)) : 1);

/** A note written without the model, for when even the handoff request will not fit: the task, the files touched, the commands run, and the last thing said. */
export function mechanicalNote(msgs: Message[]): string {
  const files = new Set<string>(), cmds: string[] = [];
  for (const m of msgs) for (const c of m.tool_calls ?? []) { try { const a = JSON.parse(c.function.arguments); if (typeof a.path === "string") files.add(`${c.function.name} ${a.path}`); else if (typeof a.command === "string") cmds.push(a.command.slice(0, 100)); } catch { /* skip */ } }
  const last = [...msgs].reverse().find((m) => m.role === "assistant" && m.content?.trim())?.content?.trim().slice(0, 400);
  return `(written automatically: the context was too small to ask the model for a summary)\nGOAL: see the task above\nDONE (tool calls, oldest first): ${[...files].slice(-40).join("; ") || "none recorded"}\nCOMMANDS: ${cmds.slice(-10).join("; ") || "none"}\nLAST SAID: ${last ?? "nothing"}\nNEXT: inspect the workspace (git status, git diff) to see the current state, then continue the task.`;
}

/** Index where the recent tail begins: the newest turns worth about `tailTokens` stay verbatim. Always at the start of a turn, never between a tool call and its results. */
export function tailStart(msgs: Message[], tailTokens: number): number {
  let used = 0, i = msgs.length;
  while (i > 1 && used < tailTokens * CHARS_PER_TOKEN) { i--; used += charsOf(msgs[i]); }
  i = Math.min(i, msgs.length - 1);
  while (i > 1 && msgs[i].role === "tool") i--;      // never start on a tool result: keep it with the call that made it
  return Math.max(1, i);
}

/** Blank tool outputs before `upto`, keeping the first line so the model remembers what each one was. */
export function maskOutputs(msgs: Message[], upto: number, floor = 200): number {
  let saved = 0;
  for (let i = 0; i < upto; i++) {
    const m = msgs[i];
    if (m.role !== "tool" || (m.content?.length ?? 0) <= floor || m.content!.startsWith("[")) continue;
    const first = m.content!.split("\n", 1)[0].slice(0, 100), stub = `[old output elided, ${m.content!.length} chars; started: ${first} … call the tool again if you need it]`;
    saved += m.content!.length - stub.length; m.content = stub;
  }
  return saved;
}

/** Shrink long string arguments (a `write_file` body, a patch) in tool calls before `upto`. The arguments stay valid JSON, so the provider still accepts the history. */
export function shrinkArgs(msgs: Message[], upto: number, max = 300): number {
  let saved = 0;
  for (let i = 0; i < upto; i++) for (const c of msgs[i].tool_calls ?? []) {
    if (c.function.arguments.length <= max) continue;
    try {
      const a = JSON.parse(c.function.arguments); let changed = false;
      for (const k of Object.keys(a)) if (typeof a[k] === "string" && a[k].length > max) { a[k] = `${a[k].slice(0, 100)}…[${a[k].length - 100} chars elided]`; changed = true; }
      if (changed) { const s = JSON.stringify(a); saved += c.function.arguments.length - s.length; c.function.arguments = s; }
    } catch { /* not JSON: leave it */ }
  }
  return saved;
}

const DROP = "[earlier turns were dropped to fit the context window; the handoff or your own notes hold what mattered]";
/** Last resort short of a handoff: remove the oldest whole turns (a call with its results), keeping the task message and the newest `keepGroups` turns. */
export function dropOldest(msgs: Message[], specs: ToolSpec[], target: number, keepGroups = 2): number {
  const first = msgs.findIndex((m) => m.role === "user"); if (first < 0) return 0;
  let dropped = 0;
  while (estimateTokens(msgs, specs) > target) {
    let g = first + 1; if (msgs[g]?.content === DROP) g++;
    let e = g + 1; while (msgs[e]?.role === "tool") e++;
    const groups = msgs.slice(g).filter((m) => m.role !== "tool").length;
    if (groups <= keepGroups || e >= msgs.length) break;
    msgs.splice(g, e - g); dropped += e - g;
    if (msgs[first + 1]?.content !== DROP) msgs.splice(first + 1, 0, { role: "user", content: DROP });
  }
  return dropped;
}

/** Shrink the transcript, in place, until the request is estimated at `target` tokens or less. Returns whether it fits and what was done. */
export function fit(msgs: Message[], specs: ToolSpec[], target: number, tail: number, drop = false): { fits: boolean; stages: string[]; saved: number } {
  const before = estimateTokens(msgs, specs), stages: string[] = [];
  for (const [label, t] of [["old tool output", tail], ["old tool output (shorter tail)", tail / 3], ["old tool output (minimal tail)", 0]] as const) {
    const upto = tailStart(msgs, t), a = maskOutputs(msgs, upto), b = shrinkArgs(msgs, upto);
    if (a + b > 0) stages.push(b ? `${label} and tool arguments` : label);
    if (estimateTokens(msgs, specs) <= target) return { fits: true, stages, saved: before - estimateTokens(msgs, specs) };
  }
  if (drop && dropOldest(msgs, specs, target) > 0) stages.push("oldest turns");
  const now = estimateTokens(msgs, specs); return { fits: now <= target, stages, saved: before - now };
}

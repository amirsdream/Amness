import type { Message, Model, ModelOpts, ToolSpec } from "./harness.ts";

/**
 * Adapter for OpenAI and OpenAI-compatible servers. It speaks two wire APIs:
 *  - Responses (/v1/responses): what current OpenAI models need. Since GPT-5.4, Chat Completions rejects function tools combined with
 *    reasoning ("Function tools with reasoning_effort are not supported ... use /v1/responses"), and the GPT-6 family is Responses-first.
 *  - Chat Completions (/v1/chat/completions): everything else (gpt-4.x, Ollama, vLLM, OpenRouter, most gateways).
 * `api: "auto"` picks Responses for reasoning models on api.openai.com and Chat elsewhere, and it self-corrects: if a server says to use
 * /v1/responses it switches, if /v1/responses does not exist it switches back, and if a reasoning option is refused it drops that option.
 */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAIOptions = {
  /** Let the caller handle 429 responses (the shared rate limiter does); the adapter still retries timeouts and 5xx. */
  externalRetry?: boolean;
  /** Server-side compaction (Responses API): once the prompt passes this many tokens the server compacts the conversation into an opaque item, and we stop re-sending what came before it. Off by default; ignored on servers that do not know the parameter. */
  compactAt?: number;
  model?: string; apiKey?: string; baseUrl?: string; retries?: number;
  /** extra request fields merged into every body */
  extra?: object;
  api?: "auto" | "responses" | "chat";
  /** reasoning effort for reasoning models; omit for the model's default */
  effort?: Effort;
  /** ask for reasoning summaries (streamed to `onThinking`). Default on; dropped automatically if the org may not use them. */
  summary?: boolean;
  /** let OpenAI keep the response server-side. Default false: stateless, reasoning is replayed by us (encrypted), nothing is retained. */
  store?: boolean;
  /** stable key that improves prompt-cache hits across requests (OpenAI only) */
  promptCacheKey?: string;
};

export class ApiError extends Error {
  status: number; /** the server's Retry-After, in milliseconds, when it sent one */ retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) { super(message); this.status = status; this.retryAfterMs = retryAfterMs; }
}

export const isReasoningModel = (m: string) => /^(o\d|gpt-([5-9]|\d{2,}))/i.test(m);
export const isOpenAIHost = (base: string) => { try { return new URL(base).hostname === "api.openai.com"; } catch { return false; } };

/** Reasoning-effort values a model accepts. Unknown reasoning models get the broad list; the adapter drops a value the server refuses. */
export function effortsFor(model: string): Effort[] {
  if (!isReasoningModel(model)) return [];
  if (/gpt-6(\.\d+)?-(astra|sol)/i.test(model)) return ["low", "medium", "high", "xhigh", "max"];          // no `none` / `minimal` on the big models
  return ["none", "low", "medium", "high", "xhigh", "max"];
}

/** Request fields that constrain the whole reply to a schema or grammar (OpenAI-style, vLLM, SGLang, llama.cpp). */
export const SCHEMA_KEYS = ["response_format", "json_schema", "guided_json", "guided_regex", "guided_grammar", "guided_choice", "structured_outputs", "grammar"];
let adapterWarn: (msg: string) => void = (m) => console.error(`note: ${m}`);
const warnedOnce = new Set<string>();
/** Where adapter warnings go (the chat app shows them as notes). Each warning is given once per process. */
export const onAdapterWarning = (fn: (msg: string) => void) => { adapterWarn = fn; };
const warnOnce = (m: string) => { if (!warnedOnce.has(m)) { warnedOnce.add(m); adapterWarn(m); } };

// ------------------------------------------------------------------ Responses API: request side
/** Our transcript -> Responses `instructions` + `input` items. Reasoning/function-call items from the same model are replayed verbatim. */
export function toResponsesInput(msgs: Message[], model: string): { instructions?: string; input: any[] } {
  let instructions: string | undefined;
  const input: any[] = [];
  for (const m of msgs) {
    if (m.role === "system") instructions = (instructions ? instructions + "\n\n" : "") + (m.content ?? "");
    else if (m.role === "user") input.push({ role: "user", content: m.images?.length ? [{ type: "input_text", text: m.content || "(continue)" }, ...m.images.map((i) => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.data}` }))] : m.content || "(continue)" });
    else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content ?? "" });
    else {
      const raw = m.raw as { api?: string; model?: string; items?: any[] } | undefined;
      if (raw?.api === "responses" && raw.model === model && Array.isArray(raw.items)) { input.push(...raw.items); continue; }   // keeps encrypted reasoning
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const c of m.tool_calls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.function.name, arguments: c.function.arguments || "{}" });
    }
  }
  // Everything before the newest compaction item is already inside it: sending it again would defeat the point.
  let cut = -1; input.forEach((it, i) => { if (it?.type === "compaction") cut = i; });
  return { instructions, input: cut > 0 ? input.slice(cut) : input };
}

const toResponsesTool = (t: ToolSpec) => ({
  type: "function", name: t.name, description: t.description || undefined,
  parameters: t.parameters.type === "object" ? t.parameters : { type: "object", properties: {} },
  strict: false,                                                                  // our schemas are not strict-mode shaped; be explicit instead of letting the API guess
});

// ------------------------------------------------------------------ Responses API: response side
/** A finished Responses object -> our Message. `raw` keeps every output item so the next request can replay reasoning. */
export function fromResponse(resp: any, model: string): Message {
  const items: any[] = resp.output ?? [];
  let text = "", calls: NonNullable<Message["tool_calls"]> = [], keep = items;
  for (const it of items) {
    if (it.type === "message") for (const c of it.content ?? []) text += c.type === "output_text" ? c.text : c.type === "refusal" ? `[declined] ${c.refusal}` : "";
    else if (it.type === "function_call") calls.push({ id: it.call_id, type: "function", function: { name: it.name, arguments: it.arguments || "{}" } });
  }
  if (resp.status === "incomplete" && resp.incomplete_details?.reason === "max_output_tokens" && calls.length) {
    // a tool call cut off mid-JSON must never run; drop it (and reasoning, which is invalid without its follow-up item) and nudge a smaller step
    calls = []; keep = items.filter((i) => i.type === "message");
    text = `${text}\n[output hit the max_output_tokens limit; I'll redo that in smaller steps]`.trim();
  }
  const u = resp.usage ?? {};
  return {
    role: "assistant", content: text || null, ...(calls.length && { tool_calls: calls }), raw: { api: "responses", model, items: keep },
    usage: {
      prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      cached_tokens: u.input_tokens_details?.cached_tokens ?? 0, reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

/** Read a streamed Responses call: forward text/reasoning deltas, return the final response object (completed/incomplete). */
export async function readResponsesStream(r: Response, h: Pick<ModelOpts, "onText" | "onThinking">): Promise<any> {
  const items: any[] = [];
  let final: any, buf = "";
  const dec = new TextDecoder();
  const handle = (j: any) => {
    switch (j.type) {
      case "response.output_text.delta": if (j.delta) h.onText?.(j.delta); break;
      case "response.reasoning_summary_text.delta": if (j.delta) h.onThinking?.(j.delta); break;
      case "response.output_item.done": items[j.output_index ?? items.length] = j.item; break;
      case "response.completed": case "response.incomplete": final = j.response; break;
      case "response.failed": throw new Error(`response failed: ${j.response?.error?.message ?? "unknown error"}`);
      case "error": throw new Error(j.message ?? j.error?.message ?? "stream error");
    }
  };
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      let j: any; try { j = JSON.parse(line.slice(5)); } catch { continue; }
      handle(j);
    }
  }
  if (final) { if (!final.output?.length && items.length) final.output = items.filter(Boolean); return final; }
  if (items.length) return { output: items.filter(Boolean), status: "incomplete", incomplete_details: { reason: "stream_ended" } };
  throw new Error("the response stream ended before it completed");
}

/** A server that sends thinking text but no reasoning count (llama.cpp): about four characters per token, so the panel and the budget see it. */
const thinkingTokens = (text: string): number | undefined => (text ? Math.ceil(text.length / 4) : undefined);

// ------------------------------------------------------------------ Chat Completions: streaming reader
async function readChatStream(r: Response, onText: (d: string) => void, onThinking?: (d: string) => void, keep = false): Promise<Message> {
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  let content = "", thinking = "", usage: Message["usage"], buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      let j: any; try { j = JSON.parse(line.slice(5)); } catch { continue; }
      if (j.usage) usage = { prompt_tokens: j.usage.prompt_tokens, completion_tokens: j.usage.completion_tokens, total_tokens: j.usage.total_tokens, cached_tokens: j.usage.prompt_tokens_details?.cached_tokens ?? j.usage.prompt_cache_hit_tokens, reasoning_tokens: j.usage.completion_tokens_details?.reasoning_tokens };
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.content) { content += d.content; onText(d.content); }
      const think = d.reasoning_content ?? d.reasoning;                               // llama.cpp, vLLM, DeepSeek, Ollama: thinking arrives beside the answer
      if (think) { thinking += think; onThinking?.(think); }
      for (const tc of d.tool_calls ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
    }
  }
  const tool_calls = calls.filter(Boolean);
  if (usage && usage.reasoning_tokens === undefined && thinking) usage = { ...usage, reasoning_tokens: thinkingTokens(thinking) };
  return { role: "assistant", content: content || null, ...(tool_calls.length && { tool_calls }), ...(keep && thinking && { thinking }), usage };   // kept only when it will be sent back
}

// ------------------------------------------------------------------ the adapter
export function openai(opts: OpenAIOptions = {}): Model {
  const base = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const model = opts.model ?? process.env.AMNESS_MODEL ?? "gpt-6.1-sol";
  const retries = opts.retries ?? 4;
  const official = isOpenAIHost(base);
  const mode = opts.api ?? "auto";
  // adapter state that self-corrects at runtime
  // optional request fields a server may not know; if it says so we stop sending that one field
  const OPTIONAL = ["prompt_cache_key", "prompt_cache_retention", "include", "stream_options", "parallel_tool_calls", "context_management"], dropped = new Set<string>();
  let useResponses = mode === "responses" || (mode === "auto" && official && isReasoningModel(model));
  let sendSummary = opts.summary ?? true, sendEffort = opts.effort !== undefined, chatNoReasoning = false, flips = 0, chatRefused = false;

  /** POST with retry/backoff on 408/429/5xx and network errors; other 4xx become ApiError immediately. */
  async function post(path: string, body: object, signal?: AbortSignal): Promise<Response> {
    const payload = JSON.stringify(body);
    for (let i = 0; ; i++) {
      let err: Error;
      try {
        const r = await fetch(base + path, { method: "POST", body: payload, signal, headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) } });   // no key (a local server): no header, not an empty "Bearer"
        if (r.ok) return r;
        const status = r.status, text = await r.text();
        const ra = r.headers.get("retry-after-ms") ? Number(r.headers.get("retry-after-ms")) : r.headers.get("retry-after") && Number.isFinite(Number(r.headers.get("retry-after"))) ? Number(r.headers.get("retry-after")) * 1000 : undefined;
        err = new ApiError(status, `HTTP ${status}: ${text}`, ra);
        if (status !== 408 && status !== 429 && status < 500) throw err;
        if (status === 429 && opts.externalRetry) throw err;                   // a shared rate limiter owns 429s: retrying here would bypass it
      } catch (e) {
        if (e instanceof ApiError && e.status !== 408 && e.status !== 429 && e.status < 500) throw e;
        if (signal?.aborted) throw e;
        err = e as Error;
      }
      if (i >= retries - 1) throw err;
      await new Promise((res) => setTimeout(res, Math.max(2 ** i * 1000, (err as ApiError).retryAfterMs ?? 0) + Math.random() * 500));
    }
  }

  async function viaResponses(messages: Message[], tools: ToolSpec[], o: ModelOpts): Promise<Message> {
    const { instructions, input } = toResponsesInput(messages, model);
    const reasoning = isReasoningModel(model) ? { ...(sendEffort && opts.effort ? { effort: opts.effort } : {}), ...(sendSummary ? { summary: "auto" } : {}) } : undefined;
    const store = opts.store ?? false;
    const body: any = {
      model, input, ...(instructions && { instructions }), store, stream: !!o.onText,
      ...(tools.length && { tools: tools.map(toResponsesTool), tool_choice: o.toolChoice ?? "auto" }),
      ...(reasoning && Object.keys(reasoning).length && { reasoning }),
      ...(reasoning && !store && { include: ["reasoning.encrypted_content"] }),     // older reasoning models only return the replayable blob when asked; newer ones always do
      ...(opts.promptCacheKey && official && { prompt_cache_key: opts.promptCacheKey, prompt_cache_retention: "24h" }),   // keep the cached prefix alive across idle gaps; dropped automatically if a model refuses it
      ...(opts.compactAt && official && { context_management: [{ type: "compaction", compact_threshold: opts.compactAt }] }),
      ...opts.extra, ...o.request,
    };
    for (const k of dropped) delete body[k];
    const r = await post("/responses", body, o.signal);
    const resp = (r.headers.get("content-type") ?? "").includes("text/event-stream") ? await readResponsesStream(r, o) : await r.json();
    if (resp.error) throw new Error(`response failed: ${resp.error.message ?? JSON.stringify(resp.error)}`);
    return fromResponse(resp, model);
  }

  async function viaChat(messages: Message[], tools: ToolSpec[], o: ModelOpts): Promise<Message> {
    const stream = !!o.onText;
    const body: any = {
      model,    // only wire fields: `raw` / `usage` belong to other adapters, and replayed tool calls need an explicit type
      messages: messages.map(({ role, content, tool_calls, tool_call_id, images, thinking }) => ({ ...(o.keepThinking && role === "assistant" && thinking && { reasoning_content: thinking }), role, content: images?.length ? [{ type: "text", text: content || "(continue)" }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : content, ...(tool_calls && { tool_calls: tool_calls.map((c) => ({ id: c.id, type: "function", function: c.function })) }), ...(tool_call_id && { tool_call_id }) })),
      ...(tools.length && { tools: tools.map((t) => ({ type: "function", function: t })), ...(o.toolChoice && { tool_choice: o.toolChoice }) }),
      ...(stream && { stream: true, stream_options: { include_usage: true } }),
      ...(chatNoReasoning && isReasoningModel(model) ? { reasoning_effort: "none" } : opts.effort && isReasoningModel(model) && sendEffort ? { reasoning_effort: opts.effort } : {}),
      ...(o.thinkingBudget !== undefined && !official && { thinking_budget_tokens: o.thinkingBudget }),   // llama.cpp's per-request thinking cap; other servers ignore an unknown field
      ...opts.extra, ...o.request,
      ...(o.keepThinking && !official && { chat_template_kwargs: { preserve_thinking: true, ...(o.request?.chat_template_kwargs as object | undefined) } }),   // Qwen-style templates drop old thinking unless told to keep it
    };
    // Never a response schema together with tools on an open-weight server: in one study that stopped tool calling entirely on vLLM and SGLang,
    // and tool_choice "required" did not bring it back (arXiv 2606.25605, read). Tools win; the schema goes; the user is told once.
    if (tools.length && !official) { const gone = SCHEMA_KEYS.filter((k) => k in body); if (gone.length) { for (const k of gone) delete body[k]; warnOnce(`not sent with tools to ${base}: ${gone.join(", ")} (a response schema together with tools can stop a local server from calling tools; use it in a tool-free request instead)`); } }
    for (const k of dropped) delete body[k];
    const r = await post("/chat/completions", body, o.signal);
    if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) return readChatStream(r, o.onText ?? (() => {}), o.onThinking, !!o.keepThinking);
    const j = await r.json(), m = j.choices[0].message;                           // server ignored `stream`, or we did not ask
    if (stream && m.content) o.onText!(m.content);
    const u = j.usage ?? {}, think: string = m.reasoning_content ?? m.reasoning ?? "";
    if (think) o.onThinking?.(think);
    const { reasoning_content: _rc, reasoning: _r, ...msg } = m;
    return { ...msg, ...(o.keepThinking && think && { thinking: think }), usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens, cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? thinkingTokens(think) } };
  }

  const call: Model = async (messages, tools, o2) => {
    const o = o2 ?? {};
    for (let step = 0; ; step++) {
      try { return useResponses ? await viaResponses(messages, tools, o) : await viaChat(messages, tools, o); }
      catch (e) {
        if (!(e instanceof ApiError) || step >= 6) throw e;
        const msg = e.message;
        const refused = e.status === 400 && /unknown|unsupported|unrecognized|not permitted|invalid/i.test(msg) ? OPTIONAL.find((k) => msg.includes(k) && !dropped.has(k)) : undefined;
        if (refused) { dropped.add(refused); continue; }                                    // e.g. a gateway that has never heard of prompt_cache_key
        // the server tells us which endpoint to use
        if (!useResponses && e.status === 400 && /\/v1\/responses|responses api/i.test(msg) && mode !== "chat" && flips++ < 2) { useResponses = true; chatRefused = true; continue; }
        if (!useResponses && e.status === 400 && /reasoning_effort/i.test(msg) && !chatNoReasoning) { chatNoReasoning = true; continue; }       // documented workaround: tools + reasoning_effort "none"
        if (useResponses && (e.status === 404 || e.status === 405) && mode !== "responses" && flips++ < 2) { useResponses = false; if (chatRefused) chatNoReasoning = true; continue; }   // gateway has no /responses: back to chat, already using the workaround
        // a reasoning option this account/model refuses: drop just that option and carry on
        if (useResponses && e.status === 400 && sendSummary && /summary|verif/i.test(msg)) { sendSummary = false; continue; }
        if (useResponses && e.status === 400 && sendEffort && /effort|reasoning/i.test(msg)) { sendEffort = false; continue; }
        throw e;
      }
    }
  };
  call.api = () => (useResponses ? "responses" : "chat");
  return call;
}

// The models a provider says it offers: GET /models on OpenAI-compatible servers (OpenAI, OpenRouter, Ollama, vLLM, LM Studio) and /v1/models on Anthropic.
// Used to complete `/model <tab>` and to extend the model picker. Cached for ten minutes; any failure (offline, no key, no such endpoint) gives an empty list.
export type ModelProbe = { provider: string; baseUrl: string; apiKey?: string };

const cache = new Map<string, { at: number; ids: string[] }>();
const TTL = 10 * 60_000;
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|audio|image|rerank/i;

export async function fetchModels(p: ModelProbe, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!p.apiKey && p.provider !== "ollama" && p.provider !== "custom") return [];   // a hosted provider refuses a request with no key: do not even try
  const key = `${p.provider}|${p.baseUrl}|${(p.apiKey ?? "").slice(-6)}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.ids;
  const base = p.baseUrl.replace(/\/+$/, "");
  const anthropic = p.provider === "anthropic";
  try {
    const res = await fetchImpl(anthropic ? `${base}/v1/models?limit=100` : `${base}/models`, {
      headers: anthropic ? { "x-api-key": p.apiKey ?? "", "anthropic-version": "2023-06-01" } : p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] };
    const ids = [...(body.data ?? []).map((m) => m.id), ...(body.models ?? []).map((m) => m.model ?? m.name)]   // Ollama's native shape uses `models`
      .filter((x): x is string => typeof x === "string" && !!x && !NOT_CHAT.test(x));
    const uniq = [...new Set(ids)].sort();
    cache.set(key, { at: Date.now(), ids: uniq });
    return uniq;
  } catch { return []; }
}

/**
 * The context window a local server reports for a model, so nobody has to type it. vLLM and LM Studio list it in /models (`max_model_len`, `loaded_context_length`, `context_length`);
 * llama.cpp reports `n_ctx` at /props (server root); Ollama needs a POST to /api/show. Hosted providers are skipped (their sizes are known). Any failure gives undefined.
 */
export async function detectWindow(p: ModelProbe & { model: string }, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  if (p.provider === "openai" || p.provider === "anthropic" || p.provider === "openrouter") return undefined;
  const base = p.baseUrl.replace(/\/+$/, ""), root = base.replace(/\/v1$/, ""), headers: Record<string, string> = p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {};
  const get = async (url: string, init: RequestInit = {}) => { try { const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(2000), ...init }); return r.ok ? ((await r.json()) as any) : undefined; } catch { return undefined; } };
  const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 512 ? Math.floor(n) : undefined; };
  const list = await get(`${base}/models`);
  const entry = (list?.data ?? []).find((m: any) => m?.id === p.model);
  const fromList = num(entry?.max_model_len) ?? num(entry?.loaded_context_length) ?? num(entry?.context_length) ?? num(entry?.max_context_length);
  if (fromList) return fromList;
  const props = await get(`${root}/props`);                                                // llama.cpp
  const fromProps = num(props?.default_generation_settings?.n_ctx) ?? num(props?.n_ctx); if (fromProps) return fromProps;
  if (p.provider !== "ollama" && !/:11434$/.test(root)) return undefined;                  // the last probe is a POST: only send it to Ollama
  // Ollama: the context the server LOADED the model with (the running-models list) is what it really uses; it cuts a longer prompt without an error.
  // The model's maximum from /api/show is used only when the model is not loaded yet. The loaded context depends on VRAM unless OLLAMA_CONTEXT_LENGTH is set.
  const ps = await get(`${root}/api/ps`), running = (ps?.models ?? []).find((m: any) => m?.name === p.model || m?.model === p.model || String(m?.name ?? "").replace(/:latest$/, "") === p.model);
  const loaded = num(running?.context_length) ?? num(running?.num_ctx); if (loaded) return loaded;
  const show = await get(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model: p.model }), headers: { ...headers, "content-type": "application/json" } });   // Ollama
  const info = show?.model_info ?? {}, key = Object.keys(info).find((k) => k.endsWith(".context_length")); return num(key && info[key]);
}

/** For tests. */
export const clearModelCache = () => cache.clear();

/** Share of prompt tokens a vLLM server served from its prefix cache (its /metrics page), or undefined when the server does not say. */
export async function prefixCacheRate(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  try {
    const r = await fetchImpl(baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/metrics", { signal: AbortSignal.timeout(2000) }); if (!r.ok) return undefined;
    const t = await r.text(), val = (name: string) => [...t.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.e+]+)`, "gm"))].reduce((n, m) => n + Number(m[1]), 0);
    const q = val("vllm:prefix_cache_queries_total"), h = val("vllm:prefix_cache_hits_total"); return q > 0 ? h / q : undefined;
  } catch { return undefined; }
}

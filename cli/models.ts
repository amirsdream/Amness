// The models a provider says it offers: GET /models on OpenAI-compatible servers (OpenAI, OpenRouter, Ollama, vLLM, LM Studio) and /v1/models on Anthropic.
// Used to complete `/model <tab>` and to extend the model picker. Cached for ten minutes; any failure (offline, no key, no such endpoint) gives an empty list.
export type ModelProbe = { provider: string; baseUrl: string; apiKey?: string };

const cache = new Map<string, { at: number; ids: string[] }>();
const TTL = 10 * 60_000;
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|audio|image|rerank/i;

export async function fetchModels(p: ModelProbe, fetchImpl: typeof fetch = fetch): Promise<string[]> {
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

/** For tests. */
export const clearModelCache = () => cache.clear();

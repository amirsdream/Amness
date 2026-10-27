// Optional semantic retrieval for memory: any function from texts to vectors. No dependency; the OpenAI-compatible adapter is a plain fetch.
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** OpenAI-compatible `/embeddings` (OpenAI, Ollama, vLLM, LM Studio...). */
export function openaiEmbedder(o: { apiKey?: string; baseUrl?: string; model?: string } = {}): Embedder {
  const base = (o.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""), key = o.apiKey ?? process.env.OPENAI_API_KEY ?? "", model = o.model ?? process.env.AMNESS_EMBED_MODEL ?? "text-embedding-3-small";
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const r = await fetch(`${base}/embeddings`, { method: "POST", headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) }, body: JSON.stringify({ model, input: texts.slice(i, i + 64).map((t) => t.slice(0, 6000)) }) });
      if (!r.ok) throw new Error(`embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as { data: { index: number; embedding: number[] }[] };
      out.push(...[...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  };
}

export const cosine = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

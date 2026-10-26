import { defineTool } from "./harness.ts";

export type SearchHit = { title: string; url: string; snippet: string };
export type SearchProvider = (query: string, n: number) => Promise<SearchHit[]>;

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Tavily (needs TAVILY_API_KEY): returns clean snippets built for agents. */
export const tavily = (key = process.env.TAVILY_API_KEY ?? ""): SearchProvider => async (query, n) => {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: n }), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`tavily HTTP ${r.status}`);
  return ((await r.json()).results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content }));
};

/** Keyless fallback: scrapes DuckDuckGo's HTML endpoint. Fragile by nature; prefer a real provider in production. */
export const duckduckgo: SearchProvider = async (query, n) => {
  const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), { headers: { "user-agent": "Mozilla/5.0 (amness)" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`duckduckgo HTTP ${r.status}`);
  const html = await r.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m; (m = re.exec(html)) && hits.length < n; ) {
    const href = decode(m[1]);
    const real = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
    hits.push({ title: strip(m[2]), url: real, snippet: strip(m[3]) });
  }
  return hits;
};

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/;

/** Fetch a URL and reduce it to readable text. Refuses non-http(s) and local/private hosts. */
export async function fetchText(url: string, max = 20_000, offset = 0): Promise<string> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) throw new Error("refusing to fetch " + url);
  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (amness)" }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const body = await r.text();
  const text = /html/.test(r.headers.get("content-type") ?? "")
    ? strip(body.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ").replace(/<(\/?(p|div|br|li|h\d|tr|section|article))[^>]*>/gi, "\n")).replace(/ ?\n ?/g, "\n")
    : body;
  const slice = text.slice(offset, offset + max);
  return slice + (text.length > offset + max ? `\n[truncated; ${text.length - offset - max} more chars. Call again with offset=${offset + max}]` : "");
}

export const webTools = (search: SearchProvider = process.env.TAVILY_API_KEY ? tavily() : duckduckgo) => [
  defineTool<{ query: string; n?: number }>({
    name: "web_search", description: "Search the web. Returns title, url, snippet per hit. Use specific queries; run several varied ones.",
    schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, n: { type: "integer" } } },
    run: async ({ query, n }) => (await search(query, Math.min(n ?? 6, 10))).map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n") || "no results; rephrase the query",
  }),
  defineTool<{ url: string; offset?: number }>({
    name: "fetch_url", description: "Fetch a web page as readable text (20k chars per call; use offset to page).",
    schema: { type: "object", required: ["url"], properties: { url: { type: "string" }, offset: { type: "integer" } } },
    run: ({ url, offset }) => fetchText(url, 20_000, offset ?? 0),
  }),
];

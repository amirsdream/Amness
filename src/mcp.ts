// MCP client: stdio, Streamable HTTP and the old HTTP+SSE transport, for both protocol eras.
// Modern = 2026-07-28 (stateless: no handshake, version and client info in every request's _meta, server/discover, required Mcp-Method/Mcp-Name headers on HTTP).
// Legacy = the initialize handshake (2025-11-25 and earlier; on HTTP with an Mcp-Session-Id). HTTP+SSE (2024-11-05) is deprecated but still met in the wild.
// Era detection follows the spec's "Backward Compatibility" sections: try the modern request first, fall back only when the answer is not a modern JSON-RPC error.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry, Tool } from "./harness.ts";

export const MCP_MODERN = "2026-07-28", MCP_LEGACY = "2025-11-25";
const CLIENT = { name: "amness", version: "1" };

/** One server entry, in the `mcpServers` shape Claude Code and Claude Desktop use (`.mcp.json`). */
export type McpServerConfig = {
  type?: "stdio" | "http" | "streamable-http" | "sse";
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  url?: string; headers?: Record<string, string>;
  /** a command that prints a JSON object of extra headers (run on connect and again after a 401/403) */
  headersHelper?: string;
  /** per-call timeout in ms (default 10 minutes) */
  timeout?: number;
  disabled?: boolean;
  /** OAuth settings for servers that need sign-in (see `amness mcp login`) */
  oauth?: { clientId?: string; clientSecret?: string; scopes?: string; callbackPort?: number; authServerMetadataUrl?: string };
};
export type McpEra = "modern" | "legacy" | "sse";
/** A question a server asks during a call: a form (fields described by a flat JSON schema) or a page to open (mode "url"). */
export type McpElicitation = { server: string; mode: "form" | "url"; message: string; schema?: { type?: string; properties?: Record<string, any>; required?: string[] }; url?: string };
export type McpPrompt = { name: string; title?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] };
export type McpResource = { uri: string; name?: string; title?: string; description?: string; mimeType?: string };
export type McpConnectOptions = {
  prefix?: string; risky?: (t: any) => boolean; deferAbove?: number; timeoutMs?: number; probeMs?: number;
  /** extra environment for a stdio server (merged over the config's env) */
  env?: Record<string, string>;
  /** root folder offered to legacy servers that ask for roots */
  cwd?: string;
  /** a bearer token (from `amness mcp login`), sent on HTTP */
  token?: () => string | undefined | Promise<string | undefined>;
  /** non-fatal problems (a tool dropped for an invalid x-mcp-header, a server log line) */
  warn?: (msg: string) => void;
  /** a server said its tool list changed (legacy notification); the hub reloads */
  onListChanged?: () => void;
  /**
   * Answer a server's question (elicitation: a form, or a URL to open). Without it, Amness says it cannot ask a person (decline).
   * Returns the MCP result: { action: "accept", content? } | { action: "decline" } | { action: "cancel" }.
   */
  elicit?: (r: McpElicitation) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  /** results longer than this go to a file under <cwd>/.amness/mcp-output and the model gets the start and the path (default 40 000 characters) */
  maxResultChars?: number;
};
export type McpServerInfo = { name?: string; version?: string; instructions?: string; capabilities?: Record<string, any> };
export type McpHandle = {
  tools: Tool[]; close: () => void;
  /** which protocol generation the server speaks: modern (2026-07-28, stateless) or legacy (initialize handshake); "sse" is legacy over the old HTTP+SSE transport */
  era: McpEra; transport: "stdio" | "http" | "sse"; server: McpServerInfo;
  /** the raw tool definitions as listed (for description pinning) */
  listed: any[];
  rpc: (method: string, params?: Record<string, unknown>) => Promise<any>;
  /** the server's prompts (shown as /mcp__<server>__<prompt>) and resources (read with read_mcp_resource) */
  prompts: McpPrompt[]; resources: McpResource[];
  getPrompt: (name: string, args: Record<string, string>) => Promise<string>;
  readResource: (uri: string) => Promise<string>;
};

export class McpError extends Error {
  code?: number; data?: any; status?: number;
  /** true when the reply was a JSON-RPC error from the protocol itself (not a bare HTTP error page): the server speaks some MCP */
  rpc?: boolean;
  /** the WWW-Authenticate header of a 401/403 */
  auth?: string;
  constructor(message: string, o: { code?: number; data?: any; status?: number; rpc?: boolean; auth?: string } = {}) { super(message); Object.assign(this, o); }
}

type Rpc = (method: string, params?: Record<string, unknown>, ms?: number) => Promise<any>;
type Transport = { rpc: Rpc; notify: (method: string, params?: Record<string, unknown>) => Promise<void>; close: () => void; kind: "stdio" | "http" | "sse"; setEra: (e: McpEra, version?: string) => void };

const caps = (o?: McpConnectOptions) => (o?.elicit ? { elicitation: { form: {}, url: {} }, roots: {} } : { roots: {} });
const meta = (o?: McpConnectOptions) => ({ "io.modelcontextprotocol/protocolVersion": MCP_MODERN, "io.modelcontextprotocol/clientInfo": CLIENT, "io.modelcontextprotocol/clientCapabilities": caps(o) });

const rootsOf = (cwd: string | undefined) => ({ roots: cwd ? [{ uri: "file://" + cwd.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/"), name: "project" }] : [] });
/** One question from a server (a legacy request, or an MRTR input request): roots, elicitation; sampling is not offered (deprecated in 2026-07-28). */
async function answerServer(method: string, params: any, o: McpConnectOptions, server: string): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  if (method === "ping") return { result: {} };
  if (method === "roots/list") return { result: rootsOf(o.cwd) };
  if (method === "elicitation/create") {
    if (!o.elicit) return { result: { action: "decline" } };
    const mode = params?.mode === "url" ? "url" : "form";
    try { return { result: await o.elicit({ server, mode, message: String(params?.message ?? ""), schema: params?.requestedSchema, url: params?.url }) }; } catch { return { result: { action: "cancel" } }; }
  }
  return { error: { code: -32601, message: `Amness does not support ${method}` } };
}

// ------------------------------------------------------------------------------------------------ stdio
function quoteWin(a: string) { return /^[\w\-.:\\/=@]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`; }
function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) { try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); return; } catch { /* fall through */ } }
  try { child.kill("SIGTERM"); } catch { /* gone */ }
}

function stdioTransport(cfg: McpServerConfig, o: McpConnectOptions): Transport {
  const env = { ...process.env, ...cfg.env, ...o.env };
  // On Windows, npx/uvx and friends are .cmd scripts that only start through a shell; quote each argument ourselves.
  const child = process.platform === "win32"
    ? spawn([cfg.command!, ...(cfg.args ?? [])].map(quoteWin).join(" "), { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true })
    : spawn(cfg.command!, cfg.args ?? [], { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let id = 0, buf = "", stderr = "", era: McpEra = "modern";
  child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-2000); });                                  // kept for error messages; never printed over the UI
  child.stdout!.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m: any; try { m = JSON.parse(line); } catch { continue; }                                         // not JSON-RPC: a stray log line
      if (m.method && m.id !== undefined) { void answerServer(m.method, m.params, o, o.prefix ?? "server").then((r) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }) + "\n")); continue; }
      if (m.method) { if (/list_changed$/.test(m.method)) o.onListChanged?.(); continue; }
      const p = pending.get(m.id); if (!p) continue; pending.delete(m.id);
      m.error ? p.fail(new McpError(m.error.message, { code: m.error.code, data: m.error.data, rpc: true })) : p.ok(m.result);
    }
  });
  const tail = () => (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` : "");
  let gone: string | undefined;
  const dead = (why: string) => { gone ??= why; for (const p of pending.values()) p.fail(new McpError(why)); pending.clear(); };
  child.on("exit", (c) => dead(`MCP server exited (${c})${tail()}`));
  child.on("error", (e) => dead(`MCP server failed to start: ${e.message}`));
  child.stdin!.on("error", () => { /* the server went away; the exit handler reports it */ });
  return {
    kind: "stdio",
    setEra: (e) => { era = e; },
    rpc: (method, params, ms = o.timeoutMs ?? 600_000) => new Promise<any>((ok, fail) => {
      if (gone) return fail(new McpError(gone));
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n); fail(new McpError(`MCP ${method} timed out after ${Math.round(ms / 1000)}s`));
        try { child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: n, reason: "timed out" } }) + "\n"); } catch { /* gone */ }   // the server should stop the work, not finish it unseen
      }, ms); timer.unref?.();
      pending.set(n, { ok: (v) => (clearTimeout(timer), ok(v)), fail: (e) => (clearTimeout(timer), fail(e)) });
      const p = era === "modern" ? { ...params, _meta: { ...meta(), ...(params?._meta as object) } } : params;     // a modern server needs the per-request fields on every request
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params: p }) + "\n");
    }),
    notify: async (method, params) => { child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params && { params }) }) + "\n"); },
    close: () => killTree(child),
  };
}

// ------------------------------------------------------------------------------------------------ HTTP
/** RFC 9110 header-safe value, or the spec's base64 sentinel. */
export function headerValue(v: string): string {
  const safe = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(v) && !(v.startsWith("=?base64?") && v.endsWith("?="));
  return safe ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;
}
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** The `x-mcp-header` annotations of a tool's input schema: [header name, property path]. Throws when one breaks the spec's rules (the tool must then be dropped). */
export function mcpParamHeaders(schema: any): { name: string; path: string[] }[] {
  const out: { name: string; path: string[] }[] = [], seen = new Set<string>();
  const walk = (s: any, path: string[], reachable: boolean) => {
    if (!s || typeof s !== "object") return;
    if (s["x-mcp-header"] !== undefined) {
      const h = s["x-mcp-header"];
      if (!reachable || !path.length) throw new Error("x-mcp-header on a property that is not reachable through properties only");
      if (typeof h !== "string" || !h || !TOKEN.test(h)) throw new Error(`x-mcp-header "${h}" is not a valid header name`);
      if (!["string", "integer", "boolean"].includes(s.type)) throw new Error(`x-mcp-header "${h}" on a ${s.type ?? "untyped"} property (only string, integer, boolean)`);
      if (seen.has(h.toLowerCase())) throw new Error(`x-mcp-header "${h}" is used twice`);
      seen.add(h.toLowerCase()); out.push({ name: h, path });
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && v && typeof v === "object") for (const [p, sub] of Object.entries(v)) walk(sub, [...path, p], reachable);
      else if (v && typeof v === "object" && k !== "x-mcp-header") for (const sub of Array.isArray(v) ? v : [v]) walk(sub, path, false);   // items, anyOf, $defs, …: not statically reachable
    }
  };
  walk(schema, [], true);
  return out;
}

/** Read an SSE body: yields each event's data (joined lines). */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(), dec = new TextDecoder(); let buf = "", event = "message", data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.search(/\r?\n/)) >= 0; ) {
        const line = buf.slice(0, i); buf = buf.slice(i + (buf[i] === "\r" ? 2 : 1));
        if (line === "") { if (data.length) yield { event, data: data.join("\n") }; event = "message"; data = []; continue; }
        if (line.startsWith(":")) continue;                                                                  // keep-alive comment
        const c = line.indexOf(":"), field = c < 0 ? line : line.slice(0, c), val = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "event") event = val; else if (field === "data") data.push(val);
      }
    }
  } finally { reader.releaseLock(); }
}

async function runHeadersHelper(cmd: string, env: Record<string, string>): Promise<Record<string, string>> {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new McpError(`headersHelper failed (${r.status ?? r.error?.message}): ${(r.stderr ?? "").slice(0, 200)}`);
  const j = JSON.parse(r.stdout || "{}"); if (!j || typeof j !== "object" || Array.isArray(j)) throw new McpError("headersHelper must print a JSON object of headers");
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
}

function httpTransport(cfg: McpServerConfig, o: McpConnectOptions, name: string): Transport & { headersFor: Map<string, { name: string; path: string[] }[]> } {
  const url = cfg.url!; let era: McpEra = "modern", version = MCP_MODERN, session: string | undefined, id = 0, helper: Record<string, string> | undefined;
  const headersFor = new Map<string, { name: string; path: string[] }[]>();
  const acs = new Set<AbortController>();
  const baseHeaders = async (retry: boolean) => {
    if (cfg.headersHelper && (!helper || retry)) helper = await runHeadersHelper(cfg.headersHelper, { AMNESS_MCP_SERVER_NAME: name, AMNESS_MCP_SERVER_URL: url });
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...cfg.headers, ...helper };
    if (!Object.keys(h).some((k) => k.toLowerCase() === "authorization")) { const t = await o.token?.(); if (t) h.authorization = `Bearer ${t}`; }
    return h;
  };
  const post = async (body: any, extra: Record<string, string>, signal: AbortSignal, retry = false): Promise<Response> => {
    try {
      const headers = { ...(await baseHeaders(retry)), ...extra };
      if (era !== "sse") headers["mcp-protocol-version"] = version;
      if (session) headers["mcp-session-id"] = session;
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      if ((r.status === 401 || r.status === 403) && !retry && cfg.headersHelper) { await r.body?.cancel(); return post(body, extra, signal, true); }
      return r;
    } catch (e) { throw signal.aborted && signal.reason instanceof McpError ? signal.reason : new McpError(`MCP server ${url} unreachable: ${(e as Error).message}`); }
  };
  /** One request with its time limit over the whole exchange, the streamed body included. On timeout the request is closed (the 2026-07-28 way to cancel); an initialize-era server also gets notifications/cancelled. */
  const exchange = async <T>(body: any, extra: Record<string, string>, ms: number, then: (r: Response) => Promise<T>): Promise<T> => {
    const ac = new AbortController(); acs.add(ac);
    const timer = setTimeout(() => {
      ac.abort(new McpError(`MCP ${body.method} timed out after ${Math.round(ms / 1000)}s`));
      if (era !== "modern" && body.id !== undefined) void post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: body.id, reason: "timed out" } }, {}, AbortSignal.timeout(10_000)).then((r) => r.body?.cancel(), () => {});
    }, ms); timer.unref?.();
    try { return await then(await post(body, extra, ac.signal)); }
    catch (e) { throw ac.signal.aborted && ac.signal.reason instanceof McpError ? ac.signal.reason : e; }
    finally { clearTimeout(timer); acs.delete(ac); }
  };
  const readReply = async (r: Response, n: number, method: string): Promise<any> => {
    const ct = r.headers.get("content-type") ?? "";
    if (r.status === 401 || r.status === 403) { await r.body?.cancel(); throw new McpError(r.status === 401 ? `MCP server needs sign-in (run: amness mcp login ${name})` : "MCP server refused access (403: missing permission or scope)", { status: r.status, auth: r.headers.get("www-authenticate") ?? undefined }); }
    if (ct.includes("text/event-stream") && r.body) {
      for await (const ev of sseEvents(r.body)) {
        let m: any; try { m = JSON.parse(ev.data); } catch { continue; }
        if (m.id === n && !m.method) return m.error ? Promise.reject(new McpError(m.error.message, { code: m.error.code, data: m.error.data, status: r.status, rpc: true })) : m.result;
        if (m.method && m.id === undefined && /list_changed$/.test(m.method)) o.onListChanged?.();
      }
      throw new McpError(`MCP ${method}: the response stream closed before the answer`, { status: r.status });
    }
    const text = await r.text(); let m: any; try { m = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    if (m?.error) throw new McpError(m.error.message, { code: m.error.code, data: m.error.data, status: r.status, rpc: typeof m.error.code === "number" });
    if (!r.ok) throw new McpError(`MCP ${method}: HTTP ${r.status}${text ? ` ${text.slice(0, 120)}` : ""}`, { status: r.status });
    return m?.result;
  };
  return {
    kind: "http", headersFor,
    setEra: (e, v) => { era = e; if (v) version = v; },
    rpc: async (method, params, ms = o.timeoutMs ?? 600_000) => {
      const n = ++id, p = era === "modern" ? { ...params, _meta: { ...meta(o), ...(params?._meta as object) } } : params;
      const extra: Record<string, string> = {};
      if (era === "modern") {
        extra["mcp-method"] = method;
        const nm = (params?.name ?? params?.uri) as string | undefined; if (nm !== undefined && /^(tools\/call|resources\/read|prompts\/get)$/.test(method)) extra["mcp-name"] = headerValue(String(nm));
        if (method === "tools/call") for (const h of headersFor.get(String(params?.name)) ?? []) {
          let v: any = params?.arguments; for (const k of h.path) v = v?.[k];
          if (v !== undefined && v !== null) extra[`mcp-param-${h.name}`] = headerValue(typeof v === "boolean" ? String(v) : String(v));
        }
      }
      return exchange({ jsonrpc: "2.0", id: n, method, ...(p && { params: p }) }, extra, ms, (r) => {
        if (method === "initialize") session = r.headers.get("mcp-session-id") ?? undefined;
        return readReply(r, n, method);
      });
    },
    notify: async (method, params) => { await exchange({ jsonrpc: "2.0", method, ...(params && { params }) }, era === "modern" ? { "mcp-method": method } : {}, 30_000, async (r) => { await r.body?.cancel(); }); },
    close: () => {
      for (const ac of acs) ac.abort(); acs.clear();
      if (session) void fetch(url, { method: "DELETE", headers: { "mcp-session-id": session, "mcp-protocol-version": version } }).then((r) => r.body?.cancel(), () => {});   // legacy servers end the session
    },
  };
}

/** The deprecated HTTP+SSE transport (2024-11-05): a GET stream whose first event names the POST endpoint; answers come back on the stream. */
async function sseTransport(cfg: McpServerConfig, o: McpConnectOptions, name: string): Promise<Transport> {
  const ac = new AbortController(), pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let helper: Record<string, string> | undefined; if (cfg.headersHelper) helper = await runHeadersHelper(cfg.headersHelper, { AMNESS_MCP_SERVER_NAME: name, AMNESS_MCP_SERVER_URL: cfg.url! });
  const headers = async () => { const h: Record<string, string> = { ...cfg.headers, ...helper }; if (!Object.keys(h).some((k) => k.toLowerCase() === "authorization")) { const t = await o.token?.(); if (t) h.authorization = `Bearer ${t}`; } return h; };
  const r = await fetch(cfg.url!, { headers: { accept: "text/event-stream", ...(await headers()) }, signal: ac.signal }).catch((e) => { throw new McpError(`MCP server ${cfg.url} unreachable: ${e.message}`); });
  if (r.status === 401) throw new McpError(`MCP server needs sign-in (run: amness mcp login ${name})`, { status: 401, auth: r.headers.get("www-authenticate") ?? undefined });
  if (!r.ok || !r.body || !(r.headers.get("content-type") ?? "").includes("text/event-stream")) { await r.body?.cancel(); throw new McpError(`MCP server ${cfg.url} is not an HTTP+SSE server (HTTP ${r.status})`, { status: r.status }); }
  let endpoint: string | undefined, id = 0; let ready!: (u: string) => void, broke!: (e: Error) => void;
  const got = new Promise<string>((res, rej) => { ready = res; broke = rej; });
  void (async () => {
    try {
      for await (const ev of sseEvents(r.body!)) {
        if (ev.event === "endpoint") { endpoint = new URL(ev.data.trim(), cfg.url).href; ready(endpoint); continue; }
        let m: any; try { m = JSON.parse(ev.data); } catch { continue; }
        if (m.method && m.id !== undefined) { const a = await answerServer(m.method, m.params, o, name); void fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json", ...(await headers()) }, body: JSON.stringify({ jsonrpc: "2.0", id: m.id, ...a }) }).then((x) => x.body?.cancel(), () => {}); continue; }
        if (m.method) { if (/list_changed$/.test(m.method)) o.onListChanged?.(); continue; }
        const p = pending.get(m.id); if (!p) continue; pending.delete(m.id);
        m.error ? p.fail(new McpError(m.error.message, { code: m.error.code, data: m.error.data, rpc: true })) : p.ok(m.result);
      }
      throw new McpError("MCP server closed the event stream");
    } catch (e) { const err = e instanceof McpError ? e : new McpError(`MCP event stream failed: ${(e as Error).message}`); broke(err); for (const p of pending.values()) p.fail(err); pending.clear(); }
  })();
  const t = setTimeout(() => broke(new McpError("MCP server sent no endpoint event")), o.probeMs ?? 10_000); t.unref?.();
  await got.finally(() => clearTimeout(t));
  return {
    kind: "sse", setEra: () => {},
    rpc: (method, params, ms = o.timeoutMs ?? 600_000) => new Promise<any>((ok, fail) => {
      const n = ++id; const timer = setTimeout(() => {
        pending.delete(n); fail(new McpError(`MCP ${method} timed out after ${Math.round(ms / 1000)}s`));
        void headers().then((h) => fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: n, reason: "timed out" } }) })).then((x) => x.body?.cancel(), () => {});
      }, ms); timer.unref?.();
      pending.set(n, { ok: (v) => (clearTimeout(timer), ok(v)), fail: (e) => (clearTimeout(timer), fail(e)) });
      void (async () => { try { const x = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json", ...(await headers()) }, body: JSON.stringify({ jsonrpc: "2.0", id: n, method, ...(params && { params }) }) }); await x.body?.cancel(); if (!x.ok) { pending.delete(n); clearTimeout(timer); fail(new McpError(`MCP ${method}: HTTP ${x.status}`, { status: x.status })); } } catch (e) { pending.delete(n); clearTimeout(timer); fail(new McpError(`MCP ${method}: ${(e as Error).message}`)); } })();
    }),
    notify: async (method, params) => { await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json", ...(await headers()) }, body: JSON.stringify({ jsonrpc: "2.0", method, ...(params && { params }) }) }).then((x) => x.body?.cancel(), () => {}); },
    close: () => ac.abort(),
  };
}

// ------------------------------------------------------------------------------------------------ connect
const isHttp = (c: McpServerConfig) => c.type === "http" || c.type === "streamable-http" || (!c.type && !!c.url && !c.command);
/** Why a config cannot be used, or undefined when it can. */
export function mcpConfigProblem(c: McpServerConfig): string | undefined {
  if (!c || typeof c !== "object") return "not an object";
  if (c.type && !["stdio", "http", "streamable-http", "sse"].includes(c.type)) return `unknown type "${c.type}" (stdio, http, sse)`;
  if ((c.type === "stdio" || (!c.type && !c.url)) && !c.command) return "a stdio server needs a command";
  if ((isHttp(c) || c.type === "sse") && !c.url) return `a ${c.type} server needs a url`;
  if (c.url) { try { const u = new URL(c.url); if (!/^https?:$/.test(u.protocol)) return "the url must start with http:// or https://"; } catch { return `bad url "${c.url}"`; } }
  return undefined;
}

/** Connect to one MCP server and list its tools. Names become `<prefix>__<tool>`. Tools the server marks destructive (or not read-only) need approval. */
export async function connectMcp(cfg: McpServerConfig, o: McpConnectOptions & { name?: string } = {}): Promise<McpHandle> {
  const bad = mcpConfigProblem(cfg); if (bad) throw new McpError(`MCP config: ${bad}`);
  const name = o.name ?? o.prefix ?? "server";
  let t: Transport = cfg.type === "sse" ? await sseTransport(cfg, o, name) : isHttp(cfg) ? httpTransport(cfg, o, name) : stdioTransport(cfg, o);
  let era: McpEra = t.kind === "sse" ? "sse" : "modern"; const server: McpServerInfo = {};
  const legacyInit = async () => {
    t.setEra("legacy", MCP_LEGACY);
    const r = await t.rpc("initialize", { protocolVersion: MCP_LEGACY, capabilities: caps(o), clientInfo: CLIENT }, o.probeMs ? Math.max(o.probeMs, 15_000) : 30_000);
    Object.assign(server, { name: r?.serverInfo?.name, version: r?.serverInfo?.version, instructions: r?.instructions, capabilities: r?.capabilities });
    if (t.kind === "http" && r?.protocolVersion) t.setEra("legacy", r.protocolVersion);
    await t.notify("notifications/initialized");
  };
  try {
    if (era === "sse") { await legacyInit(); }
    else {
      try {
        const d = await t.rpc("server/discover", { _meta: meta(o) }, o.probeMs ?? 10_000);
        Object.assign(server, { ...d?._meta?.["io.modelcontextprotocol/serverInfo"], instructions: d?.instructions, capabilities: d?.capabilities });
      } catch (e) {
        const err = e as McpError;
        if (err.code === -32022) throw new McpError(`MCP server does not support protocol ${MCP_MODERN} (it supports ${JSON.stringify(err.data?.supported ?? [])})`, err);
        if (err.status === 401 || err.status === 403) throw err;
        // Errors only a 2026-07-28 server gives: it speaks the modern protocol, so falling back to initialize would hide the real problem.
        if (err.code === -32021) throw new McpError(`MCP server needs a client capability Amness does not offer: ${err.message}`, err);
        if (err.code === -32020) throw new McpError(`MCP server refused the request headers: ${err.message}`, err);
        // Legacy: method not found, another error, a bare HTTP 400/404/405, or silence.
        era = "legacy";
        try { await legacyInit(); }
        catch (e2) {
          const e2s = (e2 as McpError).status;
          if (t.kind === "http" && (e2s === 400 || e2s === 404 || e2s === 405) && !(e2 as McpError).rpc) {   // maybe the old HTTP+SSE transport at the same address
            t.close(); t = await sseTransport(cfg, o, name); era = "sse"; await legacyInit();
          } else throw e2;
        }
      }
    }
    if (era === "modern") t.setEra("modern");
    const listed: any[] = [];
    for (let cursor: string | undefined, pages = 0; pages < 50; pages++) {
      const r = await t.rpc("tools/list", cursor ? { cursor } : {});
      listed.push(...(r?.tools ?? [])); cursor = r?.nextCursor; if (!cursor) break;
    }
    const prefix = (o.prefix ?? name).replace(/[^\w-]+/g, "_");
    const headersFor = (t as { headersFor?: Map<string, { name: string; path: string[] }[]> }).headersFor;
    const usable = listed.filter((d) => {
      if (!d || typeof d.name !== "string") return false;
      try { const hs = mcpParamHeaders(d.inputSchema); if (headersFor && hs.length) headersFor.set(d.name, hs); return true; }
      catch (e) { if (t.kind !== "http") return true; o.warn?.(`tool ${d.name} dropped: ${(e as Error).message}`); return false; }   // stdio may ignore x-mcp-header; HTTP clients MUST drop the tool
    });
    const rpc = (m: string, p?: Record<string, unknown>) => t.rpc(m, p);
    const tools = uniqueNames(usable.map((d): Tool => mcpTool(d, prefix, usable.length, o, rpc)), usable.map((d) => d.name), o.warn);
    const list = async <T>(method: string, key: string): Promise<T[]> => {
      const out: T[] = [];
      try { for (let cursor: string | undefined, pages = 0; pages < 20; pages++) { const r = await t.rpc(method, cursor ? { cursor } : {}, 15_000); out.push(...((r?.[key] ?? []) as T[])); cursor = r?.nextCursor; if (!cursor) break; } }
      catch { /* not offered */ }
      return out;
    };
    const cap = server.capabilities ?? {};
    const prompts = cap.prompts || !server.capabilities ? await list<McpPrompt>("prompts/list", "prompts") : [];
    const resources = cap.resources || !server.capabilities ? await list<McpResource>("resources/list", "resources") : [];
    return { tools, close: () => t.close(), era, transport: t.kind, server, listed: usable, rpc, prompts, resources,
      getPrompt: async (nm: string, args: Record<string, string>) => {
        const r = await mcpCall(rpc, "prompts/get", { name: nm, arguments: args }, o, prefix);
        return ((r?.messages ?? []) as any[]).map((m) => (m.content?.type === "text" ? m.content.text : m.content?.type === "resource" ? m.content.resource?.text ?? "" : "")).filter(Boolean).join("\n\n");
      },
      readResource: async (uri: string) => {
        const r = await mcpCall(rpc, "resources/read", { uri }, o, prefix);
        return spill(((r?.contents ?? []) as any[]).map((c) => c.text ?? (c.blob ? `[binary ${c.mimeType ?? ""}, ${Math.round((c.blob.length * 3) / 4 / 1024)} KB]` : "")).join("\n"), `${prefix}-resource`, o);
      } };
  } catch (e) { t.close(); throw e; }
}

/**
 * A request that may come back as "input required" (MRTR, 2026-07-28): answer each input request (roots, elicitation) and retry with
 * inputResponses and requestState, a few rounds at most. Earlier servers never do this, so the first answer is the result.
 */
export async function mcpCall(rpc: (m: string, p?: Record<string, unknown>) => Promise<any>, method: string, params: Record<string, unknown>, o: McpConnectOptions, server: string): Promise<any> {
  let r = await rpc(method, params);
  for (let round = 0; r?.resultType === "input_required" && round < 5; round++) {
    const responses: Record<string, unknown> = {};
    for (const [key, req] of Object.entries((r.inputRequests ?? {}) as Record<string, { method: string; params?: any }>)) {
      const a = await answerServer(req.method, req.params, o, server);
      if (a.error) throw new Error(`MCP ${server}: the server needs ${req.method}, which Amness does not support`);
      responses[key] = a.result;
    }
    r = await rpc(method, { ...params, inputResponses: responses, ...(r.requestState !== undefined && { requestState: r.requestState }) });
  }
  if (r?.resultType === "input_required") throw new Error(`MCP ${server}: the server kept asking for more input`);
  return r;
}

/**
 * Tool names are cleaned to [A-Za-z0-9_-] and cut to 64 characters, so "a.b" and "a_b" (or two long names) could become one name and one tool would
 * silently replace the other. A clash gets a numbered suffix and a warning instead.
 */
function uniqueNames(tools: Tool[], original: string[], warn?: (m: string) => void): Tool[] {
  const seen = new Set<string>();
  return tools.map((t, i) => {
    if (!seen.has(t.name)) { seen.add(t.name); return t; }
    let k = 2, name = t.name; while (seen.has(name)) { const suf = `_${k++}`; name = t.name.slice(0, 64 - suf.length) + suf; }
    warn?.(`tool "${original[i]}" would have the same name as another (${t.name}); it is called ${name}`);
    seen.add(name); return { ...t, name };
  });
}

/** One listed MCP tool as an Amness tool. */
function mcpTool(t: any, prefix: string, count: number, o: McpConnectOptions, rpc: (m: string, p?: Record<string, unknown>) => Promise<any>): Tool {
  const a = t.annotations ?? {};
  // Asks first unless the server says the tool only reads (readOnlyHint). Without annotations the spec's defaults apply (readOnlyHint false, destructiveHint true).
  const risky = o.risky ? o.risky(t) : a.readOnlyHint !== true || a.destructiveHint === true;
  return {
    name: `${prefix}__${t.name}`.replace(/[^\w-]/g, "_").slice(0, 64), description: t.description ?? t.title ?? t.name,
    schema: t.inputSchema ?? { type: "object" }, risky: risky ? () => `MCP tool ${t.name} may change external state` : false,
    deferred: count > (o.deferAbove ?? 15), untrusted: true,
    run: async (args) => {
      const r = await mcpCall(rpc, "tools/call", { name: t.name, arguments: args }, o, prefix);
      return spill(mcpResultText(r), `${prefix}-${t.name}`, o);
    },
  };
}

let spilled = 0;
/** A very long result would fill the context: keep the start, save the whole of it in the project, and say where (the model can read the rest with read_file). */
function spill(text: string, label: string, o: McpConnectOptions): string {
  const max = o.maxResultChars ?? 40_000; if (text.length <= max) return text;
  if (!o.cwd) return `${text.slice(0, max)}\n… [cut: the result is ${text.length} characters]`;
  const dir = join(o.cwd, ".amness", "mcp-output"), name = `${label.replace(/[^\w.-]+/g, "_").slice(0, 60)}-${Date.now().toString(36)}${(++spilled).toString(36)}.txt`;
  try {
    mkdirSync(dir, { recursive: true }); if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");   // never committed
    writeFileSync(join(dir, name), text);
  } catch { return text.slice(0, max) + `\n… [cut: ${text.length} characters in all]`; }
  const lines = text.split("\n").length;
  return `${text.slice(0, 4000)}\n…\n[The full result is ${text.length} characters (${lines} lines), more than fits here. It is saved in .amness/mcp-output/${name}: read the parts you need with read_file.]`;
}

/** A tools/call result as text for the model. Errors (isError) throw, so the model sees them as a failed call it can correct. */
export function mcpResultText(r: any): string {
  const parts = (r?.content ?? []).map((c: any) =>
    c.type === "text" ? c.text
      : c.type === "resource" ? (c.resource?.text !== undefined ? `<resource uri="${c.resource.uri}">\n${c.resource.text}\n</resource>` : `[resource ${c.resource?.uri ?? ""} (${c.resource?.mimeType ?? "binary"})]`)
      : c.type === "resource_link" ? `[link ${c.uri}${c.name ? ` "${c.name}"` : ""}]`
      : c.type === "image" ? `[image ${c.mimeType ?? ""}, ${Math.round(((c.data?.length ?? 0) * 3) / 4 / 1024)} KB]`
      : c.type === "audio" ? `[audio ${c.mimeType ?? ""}]` : `[${c.type}]`);
  const text = parts.join("\n");
  if (r?.isError) throw new Error(text || "tool error");
  return text || (r?.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : "ok");
}

/** Old entry point: a stdio server from a command line. */
export async function loadMcp(command: string, args: string[] = [], o: McpConnectOptions = {}): Promise<McpHandle> {
  return connectMcp({ command, args }, { ...o, name: o.prefix ?? command.split(/[\\/]/).pop()!.replace(/\W+/g, "_") });
}

// ------------------------------------------------------------------------------------------------ hub
/** A fingerprint of what the model reads about a tool: a change after you approved the server can carry new instructions (a "rug pull"). */
export const toolFingerprint = (t: any) => createHash("sha256").update(JSON.stringify({ n: t?.name, t: t?.title ?? "", d: t?.description ?? "", s: t?.inputSchema ?? null, o: t?.outputSchema ?? null, a: t?.annotations ?? null })).digest("hex").slice(0, 16);
/** Signs of instructions hidden in a tool's description or schema (tool poisoning). Heuristic: a finding means "read it yourself", not proof. */
export function scanTool(t: any): string[] {
  const text = `${t?.title ?? ""}\n${t?.description ?? ""}\n${JSON.stringify(t?.inputSchema ?? {})}`, out: string[] = [];
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/u.test(text)) out.push("invisible or direction-changing characters");
  if (/ignore (all |any )?(previous|prior|above|other) (instructions|rules)|disregard (the|your) (instructions|rules)|you must (always|never)\b.*\b(tool|call)/i.test(text)) out.push("tells the model to ignore its instructions");
  if (/<\s*(important|system|instructions?|secret)\s*>/i.test(text)) out.push("hidden-instruction tags (<IMPORTANT>, <system>…)");
  if (/(do not|don't|never) (tell|mention|show|inform|reveal)\b.*\b(user|human)/i.test(text)) out.push("asks to hide something from you");
  if (/(~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.env\b|api[_ -]?keys?\b|private key|password|\.netrc|\.npmrc|keychain)/i.test(t?.description ?? "")) out.push("mentions secrets or key files");
  if (/before (using|calling) (this|any) tool,? (first )?(read|call|send|fetch)|(send|post|upload) (it|them|the (contents?|file|result)s?) to (https?:|the url)/i.test(text)) out.push("asks for extra steps that move data");
  if ((t?.description ?? "").length > 4000) out.push(`a very long description (${(t.description as string).length} characters)`);
  return out;
}
export type McpPin = { h: string; d: string };
/** Where the hub remembers the approved tool fingerprints (state.json in the CLI). */
export type McpPinStore = { get: (key: string) => Record<string, McpPin> | undefined; set: (key: string, pins: Record<string, McpPin>) => void };
export type McpChange = { tool: string; kind: "changed" | "new"; before?: string; now: string };

export type McpScope = "local" | "project" | "user" | "cli" | "editor" | "session";
export type McpEntry = { name: string; config: McpServerConfig; scope: McpScope; file?: string; pending?: boolean; disabled?: boolean };
export type McpStatus = "connecting" | "connected" | "failed" | "pending" | "disabled" | "needs-login";
export type McpRow = { name: string; scope: McpScope; status: McpStatus; error?: string; tools: number; transport: string; era?: McpEra; file?: string; target: string; /** tools held back because they changed since you approved them (or are new) */ changed: McpChange[]; /** tool → findings of scanTool */ warnings: Record<string, string[]> };

export type McpHubOptions = McpConnectOptions & { onChange?: () => void; tokenFor?: (name: string, cfg: McpServerConfig) => (() => Promise<string | undefined>) | undefined; /** remember approved tool descriptions; without it nothing is pinned */ pins?: McpPinStore; pinKey?: (e: McpEntry) => string };
/** All the MCP servers of a session: connects them in parallel, keeps each one's status, gives their tools. */
export class McpHub {
  private servers = new Map<string, { entry: McpEntry; status: McpStatus; error?: string; handle?: McpHandle; changed?: McpChange[]; warnings?: Record<string, string[]> }>();
  private o: McpHubOptions; private warnedDup = new Set<string>();
  constructor(o: McpHubOptions = {}) { this.o = o; }

  /** Replace the configured set and connect what is new or changed; servers no longer listed are closed. */
  async start(entries: McpEntry[]): Promise<void> {
    const want = new Map(entries.map((e) => [e.name, e]));
    for (const [n, s] of this.servers) if (!want.has(n) || JSON.stringify(want.get(n)!.config) !== JSON.stringify(s.entry.config)) { s.handle?.close(); this.servers.delete(n); }
    const jobs: Promise<void>[] = [];
    for (const e of entries) {
      const cur = this.servers.get(e.name);
      if (cur && cur.status === "connected" && !e.disabled && !e.pending) { cur.entry = e; continue; }
      cur?.handle?.close();
      if (e.disabled) { this.servers.set(e.name, { entry: e, status: "disabled" }); continue; }
      if (e.pending) { this.servers.set(e.name, { entry: e, status: "pending" }); continue; }
      jobs.push(this.connect(e));
    }
    this.o.onChange?.();
    await Promise.all(jobs);
  }
  async connect(e: McpEntry): Promise<void> {
    this.servers.set(e.name, { entry: e, status: "connecting" }); this.o.onChange?.();
    try {
      const handle = await connectMcp(e.config, { ...this.o, name: e.name, prefix: e.name, token: this.o.tokenFor?.(e.name, e.config) ?? this.o.token, timeoutMs: e.config.timeout ?? this.o.timeoutMs, onListChanged: () => void this.reload(e.name) });
      const cur = this.servers.get(e.name); if (!cur || cur.entry !== e) { handle.close(); return; }     // replaced or removed while connecting
      cur.handle = handle; cur.status = "connected"; cur.error = undefined;
      cur.warnings = Object.fromEntries(handle.listed.map((d) => [d.name, scanTool(d)]).filter(([, w]) => (w as string[]).length));
      cur.changed = this.compare(e, handle);
    } catch (err) {
      const cur = this.servers.get(e.name); if (!cur || cur.entry !== e) return;
      const x = err as McpError; cur.status = x.status === 401 ? "needs-login" : "failed"; cur.error = x.message;
    }
    this.o.onChange?.();
  }
  /** Reconnect one server (or all) — after a login, a changed list, or a crash. */
  async reconnect(name?: string): Promise<void> {
    const list = [...this.servers.values()].filter((s) => (name ? s.entry.name === name : true) && s.status !== "disabled" && s.status !== "pending");
    for (const s of list) s.handle?.close();
    await Promise.all(list.map((s) => this.connect(s.entry)));
  }
  private keyOf(e: McpEntry) { return this.o.pinKey?.(e) ?? `${e.scope}:${e.name}:${e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" ")}`; }
  /** First connection: remember every tool. Later: tools whose description or schema changed, and new tools, are held back until approve(). */
  private compare(e: McpEntry, h: McpHandle): McpChange[] {
    const store = this.o.pins; if (!store) return [];
    const key = this.keyOf(e), old = store.get(key), now: Record<string, McpPin> = Object.fromEntries(h.listed.map((d) => [d.name, { h: toolFingerprint(d), d: String(d.description ?? "").slice(0, 4000) }]));
    if (!old) { store.set(key, now); return []; }
    const out: McpChange[] = [];
    for (const [tool, p] of Object.entries(now)) if (!old[tool]) out.push({ tool, kind: "new", now: p.d }); else if (old[tool].h !== p.h) out.push({ tool, kind: "changed", before: old[tool].d, now: p.d });
    if (!out.length) { const removed = Object.keys(old).some((k) => !now[k]); if (removed) store.set(key, now); }   // a tool that went away: nothing to approve
    return out;
  }
  /** Accept a server's current tools (after you read the changes). */
  approve(name: string) {
    const s = this.servers.get(name); if (!s?.handle || !this.o.pins) return;
    this.o.pins.set(this.keyOf(s.entry), Object.fromEntries(s.handle.listed.map((d) => [d.name, { h: toolFingerprint(d), d: String(d.description ?? "").slice(0, 4000) }])));
    s.changed = []; this.o.onChange?.();
  }
  private async reload(name: string) { const s = this.servers.get(name); if (s?.status === "connected") await this.connect(s.entry); }
  /** The usable tools: of connected servers, without the ones held back for approval; plus list_mcp_resources and read_mcp_resource when a server has resources. */
  tools(): Tool[] {
    const withRes = [...this.servers.values()].filter((s) => s.status === "connected" && s.handle!.resources.length);
    const res: Tool[] = withRes.length ? [
      { name: "list_mcp_resources", description: "List the resources (documents, records, files) that connected MCP servers offer. Read one with read_mcp_resource.", untrusted: true, risky: false,
        schema: { type: "object", properties: { server: { type: "string", description: "only this server" } } },
        run: async (a: any) => withRes.filter((s) => !a?.server || s.entry.name === a.server).flatMap((s) => s.handle!.resources.slice(0, 200).map((r) => `${s.entry.name}  ${r.uri}${r.name || r.title ? `  ${r.title ?? r.name}` : ""}${r.description ? ` — ${String(r.description).slice(0, 120)}` : ""}`)).join("\n") || "no resources" },
      { name: "read_mcp_resource", description: "Read one resource of an MCP server by its URI (see list_mcp_resources).", untrusted: true, risky: false,
        schema: { type: "object", required: ["server", "uri"], properties: { server: { type: "string" }, uri: { type: "string" } } },
        run: async (a: any) => { const s = withRes.find((x) => x.entry.name === a?.server); if (!s) throw new Error(`no connected server "${a?.server}" with resources (${withRes.map((x) => x.entry.name).join(", ")})`); return s.handle!.readResource(String(a.uri)); } },
    ] : [];
    const taken = new Set(res.map((t) => t.name));
    return [...res, ...[...this.servers.values()].flatMap((s) => {
      if (s.status !== "connected") return [];
      const held = new Set((s.changed ?? []).map((c) => c.tool)); if (!held.size) return s.handle!.tools;
      return s.handle!.tools.filter((t, i) => !held.has(s.handle!.listed[i]?.name));
    }).filter((t) => {                                                                                // two servers whose names clean up the same ("a.b", "a_b"): the first keeps the name
      if (!taken.has(t.name)) { taken.add(t.name); return true; }
      if (!this.warnedDup.has(t.name)) { this.warnedDup.add(t.name); this.o.warn?.(`two MCP servers give a tool named ${t.name}; the second one is left out (rename one of the servers)`); }
      return false;
    })];
  }
  /** Every connected server's prompts. */
  prompts(): { server: string; prompt: McpPrompt; run: (args: Record<string, string>) => Promise<string> }[] {
    return [...this.servers.values()].flatMap((s) => (s.status === "connected" ? s.handle!.prompts.map((p) => ({ server: s.entry.name, prompt: p, run: (a: Record<string, string>) => s.handle!.getPrompt(p.name, a) })) : []));
  }
  handle(name: string): McpHandle | undefined { return this.servers.get(name)?.handle; }
  rows(): McpRow[] {
    return [...this.servers.values()].map((s) => ({
      name: s.entry.name, scope: s.entry.scope, status: s.status, error: s.error, tools: s.handle?.tools.length ?? 0,
      transport: s.handle?.transport ?? (s.entry.config.type === "sse" ? "sse" : s.entry.config.url && !s.entry.config.command ? "http" : "stdio"),
      era: s.handle?.era, file: s.entry.file, target: s.entry.config.url ?? [s.entry.config.command, ...(s.entry.config.args ?? [])].join(" "),
      changed: s.changed ?? [], warnings: s.warnings ?? {},
    }));
  }
  get size() { return this.servers.size; }
  close() { for (const s of this.servers.values()) s.handle?.close(); this.servers.clear(); }
}

/** Convenience: add a stdio MCP server's tools to a registry; returns the close function. */
export async function mountMcp(reg: Registry, command: string, args?: string[], o?: McpConnectOptions) {
  const h = await loadMcp(command, args, o); reg.add(...h.tools); return h.close;
}

// The desktop app's local server: the window's page, a live event stream (SSE) and a small JSON API over one DesktopSession.
// It listens on 127.0.0.1 only and every request must carry a random per-launch token, so no website and no other user can drive your agent.
// Host and Origin are checked as well (DNS rebinding), and the page runs under a strict Content-Security-Policy with no inline script.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { hostname, networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import type { Model } from "../../src/index.ts";
import { savePastedImage } from "../tui/external.ts";
import { fileOpenCommand } from "../tui/find.ts";
import { DesktopBridge, type ServerEvent } from "./bridge.ts";
import { spawn } from "node:child_process";
const UI = fileURLToPath(new URL("./ui/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MODES = ["default", "acceptEdits", "plan", "yolo"] as const;

export type DesktopServer = { url: string; token: string; bridge: DesktopBridge; close: () => Promise<void>; /** every address it answers on (for amness serve's banner) */ urls: string[]; port: number };
/** How `amness serve` opens the same server to the network: a fixed token, another address, TLS, its own routes, a log. The desktop app uses none of these. */
export type NetOptions = {
  host?: string; token?: string; allowHosts?: string[]; tls?: { cert: Buffer; key: Buffer };
  /** more routes (the /v1 API); return true when handled. `authed` says whether the request carried the token. */
  extra?: (req: IncomingMessage, res: ServerResponse, u: URL, authed: boolean) => Promise<boolean>;
  log?: (line: Record<string, unknown>) => void;
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** The host names a server bound to `host` answers to (Host-header check against DNS rebinding). */
export function hostsFor(host: string, port: number, extra: string[] = []): Set<string> {
  const names = new Set<string>(["127.0.0.1", "localhost", "[::1]"]);
  const any = host === "0.0.0.0" || host === "::";
  if (!LOOPBACK.has(host)) {
    names.add(host.includes(":") ? `[${host}]` : host);
    if (any) for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) names.add(i.family === "IPv6" ? `[${i.address.split("%")[0]}]` : i.address);
    const h = hostname().toLowerCase(); names.add(h); if (!h.endsWith(".local")) names.add(`${h}.local`);
  }
  for (const e of extra) names.add(e.toLowerCase());
  const out = new Set<string>(); for (const n of names) { out.add(`${n}:${port}`); if (extra.includes(n)) out.add(n); }   // a reverse proxy's name may come without the port
  return out;
}

export async function startDesktopServer(o: { cfg: Config; cwd: string; version: string; port?: number; persist?: boolean; makeModel?: (c: Config) => Model; net?: NetOptions }): Promise<DesktopServer> {
  const net = o.net ?? {}, bindHost = net.host ?? "127.0.0.1", scheme = net.tls ? "https" : "http";
  const token = net.token ?? randomBytes(24).toString("base64url"), clients = new Set<ServerResponse>();
  const send = (e: ServerEvent) => { const d = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(d); };
  const bridge = new DesktopBridge({ cfg: o.cfg, cwd: o.cwd, version: o.version, emit: send, persist: o.persist, makeModel: o.makeModel });
  let port = 0, allowed = new Set<string>(); const fails = new Map<string, { n: number; at: number }>();

  const okToken = (t: string | null | undefined) => { if (!t) return false; const a = Buffer.from(t), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const body = (req: IncomingMessage, limit: number) => new Promise<any>((ok, fail) => {
    let n = 0; const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > limit) { fail(new Error("request too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { fail(new Error("bad JSON")); } });
    req.on("error", fail);
  });

  const api: Record<string, (b: any, q: URLSearchParams) => unknown> = {
    "GET /api/state": () => bridge.state(),
    "POST /api/send": (b) => { bridge.send(String(b.text ?? "")); return { ok: true }; },
    "POST /api/stop": () => { bridge.stop(); return { ok: true }; },
    "POST /api/mode": (b) => { if (!MODES.includes(b.mode)) throw new Error("unknown mode"); bridge.setMode(b.mode); return { ok: true }; },
    "POST /api/dialog": (b) => { bridge.answer(Number(b.id), b.value === null || b.value === undefined ? null : b.value); return { ok: true }; },
    "GET /api/dialog-preview": (_b, q) => bridge.preview(Number(q.get("id")), Number(q.get("i"))),
    "GET /api/prefs": () => bridge.prefs(),
    "POST /api/prefs": (b) => bridge.setPrefs(b && typeof b === "object" ? b : {}),
    "GET /api/settings": () => bridge.settings(),
    "POST /api/settings": (b) => bridge.applySettings(Array.isArray(b.changes) ? b.changes.filter((c: any) => c && typeof c.id === "string" && ["string", "number", "boolean"].includes(typeof c.value)).slice(0, 200) : [], ["chat", "project", "team", "user"].includes(b.scope) ? b.scope : undefined),
    "POST /api/command": async (b) => ({ lines: await bridge.command(String(b.text ?? "")) }),
    "POST /api/scheme": (b) => { bridge.setScheme(b.scheme === "light" || b.scheme === "retro" ? b.scheme : "dark"); return { ok: true }; },
    "POST /api/step": (b) => { bridge.toggleStep(Number(b.n)); return { ok: true }; },
    "GET /api/commands": () => bridge.commands(),
    "POST /api/suggest": (b) => bridge.suggest(String(b.text ?? ""), Number(b.cursor ?? 0)),
    "GET /api/sessions": (_b, q) => bridge.sessions(q.get("q") ?? ""),
    "GET /api/preview": (_b, q) => bridge.sessionPreview(q.get("id") ?? ""),
    "POST /api/resume": async (b) => { await bridge.resume(String(b.id)); return { ok: true }; },
    "POST /api/new": async () => { await bridge.newConversation(); return { ok: true }; },
    "GET /api/turns": () => bridge.turns(),
    "POST /api/edit": async (b) => { await bridge.editMessage(Number(b.blockId), String(b.text ?? "")); return { ok: true }; },
    "POST /api/rewind": async (b) => { await bridge.rewind(Number(b.index)); return { ok: true }; },
    "GET /api/files": () => bridge.fileList(),
    "GET /api/file": (_b, q) => bridge.readFile(q.get("path") ?? ""),
    "POST /api/project": (b) => { bridge.openProject(String(b.dir ?? "")); return { ok: true }; },
    "GET /api/projects": () => bridge.recentProjects(),
    "POST /api/image": (b) => { const png = Buffer.from(String(b.data ?? ""), "base64"); if (!png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) throw new Error("only PNG images can be pasted"); return { path: savePastedImage(bridge.cwd, png) }; },
    "POST /api/open-file": (b) => {                                                        // open in the user's own editor (GUI editors in their window; anything else in the OS default app)
      const f = bridge.readFile(String(b.path)).path, ed = process.env.VISUAL || process.env.EDITOR || "";
      let how = fileOpenCommand(ed, join(bridge.cwd, f), Number(b.line) || 1); if (how.terminal) how = fileOpenCommand("", join(bridge.cwd, f));
      try { const p = spawn(how.cmd, { shell: true, detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); } catch { /* nothing to open with */ }
      return { ok: true };
    },
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1"), host = (req.headers.host ?? "").toLowerCase(), ip = req.socket.remoteAddress ?? "?";
    if (!allowed.has(host)) { res.writeHead(403).end("forbidden host"); return; }
    if (req.headers.origin && !(req.headers.origin.startsWith(`${scheme}://`) && allowed.has(req.headers.origin.slice(scheme.length + 3).toLowerCase()))) { res.writeHead(403).end("forbidden origin"); return; }
    const f = fails.get(ip); if (f && f.n >= 20 && Date.now() - f.at < 60_000) { res.writeHead(429, { "retry-after": "60" }).end("too many wrong tokens; wait a minute"); return; }
    const given = (req.headers["x-amness-token"] as string | undefined) ?? (/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]) ?? (u.pathname.endsWith("/events") ? u.searchParams.get("t") ?? undefined : undefined);
    const authed = okToken(given);
    if (given && !authed) fails.set(ip, { n: (f && Date.now() - f.at < 60_000 ? f.n : 0) + 1, at: Date.now() });
    if (net.log && (req.method !== "GET" || u.pathname.startsWith("/v1/"))) res.on("finish", () => net.log!({ t: new Date().toISOString(), ip, method: req.method, path: u.pathname, status: res.statusCode }));
    if (net.extra && (u.pathname.startsWith("/v1/") || u.pathname === "/mcp") && (await net.extra(req, res, u, authed))) return;
    if (u.pathname === "/" || u.pathname === "/index.html") {                              // the page itself is harmless; the token travels in the fragment, never to the server log
      res.writeHead(200, { "content-type": TYPES[".html"], "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });
      res.end(readFileSync(join(UI, "index.html"))); return;
    }
    if (/^\/[\w.-]+\.(js|css|svg|png)$/.test(u.pathname)) {                             // the page's own files (and the app icon for the About section)
      try { res.writeHead(200, { "content-type": TYPES[extname(u.pathname)], "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(readFileSync(join(UI, u.pathname.slice(1)))); }
      catch { res.writeHead(404).end(); }
      return;
    }
    if (u.pathname === "/events") {
      if (!authed) { res.writeHead(401).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": hello\n\n"); clients.add(res); req.on("close", () => clients.delete(res));
      bridge.hello(); return;
    }
    const route = api[`${req.method} ${u.pathname}`];
    if (!route) { json(res, 404, { error: "not found" }); return; }
    if (!authed) { json(res, 401, { error: "unauthorised" }); return; }
    try {
      const b = req.method === "POST" ? await body(req, u.pathname === "/api/image" ? 25 << 20 : 2 << 20) : {};
      json(res, 200, (await route(b, u.searchParams)) ?? { ok: true });
    } catch (e) { json(res, 400, { error: (e as Error).message }); }
  };
  const server = net.tls ? createHttps({ cert: net.tls.cert, key: net.tls.key }, handler) : createServer(handler);
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(o.port ?? 0, bindHost, ok); });
  port = (server.address() as AddressInfo).port; allowed = hostsFor(bindHost, port, net.allowHosts);
  const shown = LOOPBACK.has(bindHost) ? ["127.0.0.1"] : [...new Set([...allowed].map((h) => h.replace(/:\d+$/, "")).filter((h) => !LOOPBACK.has(h) && !/^\[(fe80|::1)/i.test(h)))];
  const ping = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20_000);
  return {
    url: `${scheme}://127.0.0.1:${port}/#t=${token}`, token, bridge, port, urls: shown.map((h) => `${scheme}://${h}:${port}/`),
    close: () => new Promise<void>((ok) => { clearInterval(ping); for (const c of clients) c.end(); bridge.close(); server.close(() => ok()); server.closeAllConnections?.(); }),
  };
}

// `amness serve`: Amness as a long-running service. One server gives
//   - the desktop app's interface in any browser (your phone on the home network too): open the printed address
//   - the /v1 HTTP API (JSON + Server-Sent Events) for scripts, CI, the Evaluation Studio and other agents (docs/api.md)
// Every request needs the token (saved in ~/.amness/serve.json, owner-only). By default it listens on this computer only.
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { home, loadConfig } from "./config.ts";
import { bold, cyan, dim, green, red, strip, yellow } from "./ui.ts";

const VERSION: string = (() => { for (const rel of ["../package.json", "../../package.json"]) { try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version; } catch { /* the built copy sits one folder deeper */ } } return "0.0.0"; })();

export const SERVE_HELP = `amness serve [options]      run Amness as a service: the app in your browser plus the /v1 HTTP API
  --host <address>          where to listen (default 127.0.0.1: this computer only). 0.0.0.0 = every network you are on
  --port <n>                default 4747
  --root <folder>           folders sessions may use (repeatable; default: the folder you start it in). --root ~ for all of yours
  --allow-host <name>       another name the server is reached by (a reverse proxy's domain), repeatable
  --tls-cert <file> --tls-key <file>   serve HTTPS (or put a reverse proxy with TLS in front)
  --max-sessions <n>        open API sessions at once (default 16)
  --log <file>              request log (default ~/.amness/serve.log; --log off)
amness serve token [--rotate]   print the token (or make a new one; old clients then need the new one)

The token: AMNESS_SERVE_TOKEN, else ~/.amness/serve.json (made on first start, readable only by you).
API: docs/api.md, or GET /v1/openapi.json. Send Authorization: Bearer <token>.`;

const tokenFile = () => join(home(), "serve.json");
/** The service token: AMNESS_SERVE_TOKEN, else the saved one, else a new one (saved owner-only). */
export function serveToken(rotate = false): string {
  if (process.env.AMNESS_SERVE_TOKEN && !rotate) return process.env.AMNESS_SERVE_TOKEN;
  const f = tokenFile();
  if (!rotate && existsSync(f)) { try { const t = JSON.parse(readFileSync(f, "utf8")).token; if (typeof t === "string" && t.length >= 24) return t; } catch { /* made again below */ } }
  const t = randomBytes(32).toString("base64url");
  writeFileSync(f, JSON.stringify({ token: t, created: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 }); try { chmodSync(f, 0o600); } catch { /* Windows */ }
  return t;
}

export async function runServe(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(SERVE_HELP); return 0; }
  if (argv[0] === "token") { const t = serveToken(argv.includes("--rotate")); console.log(t); if (argv.includes("--rotate")) console.error(dim("a new token: restart amness serve, and give it to your clients")); return 0; }
  const vals = new Map<string, string[]>(), rest: string[] = [];
  const VALUE = new Set(["--host", "--port", "--root", "--allow-host", "--tls-cert", "--tls-key", "--max-sessions", "--log"]);
  for (let i = 0; i < argv.length; i++) { if (VALUE.has(argv[i]) && argv[i + 1] !== undefined) { vals.set(argv[i], [...(vals.get(argv[i]) ?? []), argv[++i]]); } else rest.push(argv[i]); }
  if (rest.length) { console.error(`unknown argument ${rest[0]}\n\n${SERVE_HELP}`); return 2; }
  const one = (k: string) => vals.get(k)?.at(-1);
  const host = one("--host") ?? "127.0.0.1", port = Number(one("--port") ?? 4747);
  const expand = (p: string) => resolve(p.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
  const roots = (vals.get("--root") ?? [process.cwd()]).map(expand);
  const certF = one("--tls-cert"), keyF = one("--tls-key");
  if (!!certF !== !!keyF) { console.error("--tls-cert and --tls-key go together"); return 2; }
  const tls = certF && keyF ? { cert: readFileSync(certF), key: readFileSync(keyF) } : undefined;
  const logTo = one("--log") === "off" ? undefined : one("--log") ?? join(home(), "serve.log");
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const token = serveToken(), cfg = loadConfig();

  const { ApiSessions } = await import("./serve/sessions.ts"), { v1Routes } = await import("./serve/api.ts"), { startDesktopServer } = await import("./desktop/server.ts");
  const sessions = new ApiSessions({ cfg, version: VERSION, roots, defaultCwd: roots[0], max: Number(one("--max-sessions") ?? 16), persist: true });
  const v1 = v1Routes(sessions, { version: VERSION });
  let srv;
  try {
    srv = await startDesktopServer({ cfg, cwd: roots[0], version: VERSION, port, persist: true, net: { host, token, tls, allowHosts: vals.get("--allow-host"), extra: v1.handler, log: logTo ? (l) => { try { appendFileSync(logTo, JSON.stringify(l) + "\n"); } catch { /* read-only */ } } : undefined } });
  } catch (e) { console.error(`${red("✗")} could not listen on ${host}:${port}: ${(e as Error).message}`); return 1; }
  const plain = !process.stdout.isTTY || !!process.env.NO_COLOR, say = (l: string) => console.log(plain ? strip(l) : l);   // a service log (journald, launchd) gets no colour codes
  const urls = srv.urls.length ? srv.urls : [`${tls ? "https" : "http"}://127.0.0.1:${srv.port}/`];
  say(`${green("●")} ${bold("amness serve")} ${VERSION} · ${local ? "this computer only" : `on ${host}`} · folders: ${roots.join(", ")}`);
  for (const u of urls) say(`  app   ${cyan(`${u}#t=${token}`)}`);
  say(`  API   ${cyan(`${urls[0]}v1/`)}  ${dim(`(Authorization: Bearer <token>; docs/api.md, GET /v1/openapi.json)`)}`);
  say(dim(`  token: amness serve token · log: ${logTo ?? "off"} · stop: Ctrl+C`));
  if (!local && !tls) say(yellow(`  ! not encrypted: anyone on this network who sees the traffic sees the token. Use --tls-cert/--tls-key or a TLS reverse proxy, and only trusted networks.`));
  if (!local) say(yellow(`  ! whoever has the token can run commands in ${roots.join(", ")} as you. Keep it secret (amness serve token --rotate makes a new one).`));
  await new Promise<void>((done) => { const stop = () => done(); process.once("SIGINT", stop); process.once("SIGTERM", stop); });
  console.log(dim("stopping…")); v1.close(); sessions.closeAll(); await srv.close();
  return 0;
}

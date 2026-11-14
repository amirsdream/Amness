#!/usr/bin/env node
// `amness-desktop [folder]`: the desktop app. The agent runs here, in Node, exactly as in the terminal UI; Electron only draws the window.
// When the window closes, this process stops the agent and exits. If Electron cannot start (a blocked download, an unsupported system),
// the same app opens in a Chrome/Edge app window, or in the browser, instead of failing.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { isTrustedDir, loadState } from "./state.ts";
import { openUrl } from "./tui/openurl.ts";

const VERSION: string = (() => { for (const rel of ["../package.json", "../../package.json"]) { try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version; } catch { /* try the next */ } } return "dev"; })();
const HELP = `amness-desktop ${VERSION}: the Amness desktop app

usage: amness-desktop [folder] [--browser] [--no-window] [--port n]
       amness-desktop --connect <address> [--token <token>]

  folder        the project to open (default: this folder, or the last project when started from a dock or menu)
  --browser     open in your browser instead of the app window
  --no-window   only start the local server and print its address
  --port n      use this port (default: any free port)
  --connect     open a running \`amness serve\` (this computer or another one) in the window; the token comes from
                --token, the address (#t=…) or AMNESS_SERVE_TOKEN

Settings, API keys and conversations are shared with the terminal app (amness).`;

/** The Electron binary that came with this package, or undefined if it is missing. */
export function electronBinary(): string | undefined {
  try { const p = createRequire(import.meta.url)("electron"); return typeof p === "string" && existsSync(p) ? p : undefined; } catch { return undefined; }
}

/** A Chromium-based browser that can open a page as its own app window (no tabs, no address bar). */
function chromeApp(): string | undefined {
  const c = process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32" ? [`${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"].map((n) => spawnSync("which", [n], { encoding: "utf8" }).stdout?.trim()).filter(Boolean) as string[];
  return c.find((p) => p && existsSync(p));
}

export async function runDesktop(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  if (argv.includes("--version")) { console.log(VERSION); return 0; }
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const folder = argv.find((a, i) => !a.startsWith("--") && !["--port", "--connect", "--token"].includes(argv[i - 1]));
  if (val("--connect")) return connect(val("--connect")!, val("--token"));
  // Started from a dock, a menu or Finder the working folder is / or the home folder: open the last project instead.
  const launched = process.cwd() === "/" || process.cwd() === homedir();
  const st = loadState(), recent = ((st as { recentProjects?: string[] }).recentProjects ?? []).find((p) => existsSync(p) && isTrustedDir(st, p));   // never a folder you did not trust: it would ask again at every start
  const cwd = resolve(folder ?? (launched && recent ? recent : process.cwd()));
  if (!existsSync(cwd)) { console.error(`amness-desktop: no such folder: ${cwd}`); return 2; }

  // The window comes first: Electron starts now and shows its start screen (ui/splash.html) while the agent and its server load here,
  // then gets the address on stdin. Loading the server is most of the wait, so it is imported only after the window is on its way.
  let child: ChildProcess | undefined, srv: Awaited<ReturnType<typeof import("./desktop/server.ts").startDesktopServer>> | undefined;
  const stop = async (code = 0) => { await srv?.close(); process.exit(code); };
  process.on("SIGINT", () => void stop(0)); process.on("SIGTERM", () => void stop(0));
  const bin = argv.includes("--browser") || argv.includes("--no-window") ? undefined : electronBinary();
  if (bin) {
    const main = fileURLToPath(new URL("./desktop/electron-main.cjs", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, AMNESS_DESKTOP_WAIT: "1" };
    delete env.ELECTRON_RUN_AS_NODE; delete env.AMNESS_DESKTOP_URL;                         // ELECTRON_RUN_AS_NODE (set by some editors) would make Electron plain Node
    child = spawn(bin, [main], { stdio: ["pipe", "ignore", "inherit"], env });
    child.on("error", (e) => { console.error(`amness-desktop: Electron did not start (${e.message}); opening it another way`); child = undefined; if (srv) void fallback(); });
    child.on("exit", () => void stop(0));
    child.stdin?.on("error", () => { /* the window closed first */ });
  }
  const { startDesktopServer } = await import("./desktop/server.ts");
  srv = await startDesktopServer({ cfg: loadConfig(), cwd, version: VERSION, port: val("--port") ? Number(val("--port")) : undefined });

  if (argv.includes("--no-window")) { console.log(`Amness desktop is running at ${srv.url}\n(keep the address private: it carries the access token). Ctrl+C stops it.`); return await new Promise<number>(() => {}); }
  if (child) child.stdin?.write(JSON.stringify({ url: srv.url, title: `Amness · ${srv.bridge.state().project}` }) + "\n");
  else await fallback();

  async function fallback() {
    if (!srv) return;
    const chrome = argv.includes("--browser") ? undefined : chromeApp();
    if (chrome) {
      const profile = resolve(homedir(), ".amness", "desktop-profile");
      const c = spawn(chrome, [`--app=${srv.url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"], { stdio: "ignore" });
      c.on("exit", () => void stop(0)); c.on("error", () => void browser());
    } else await browser();
  }
  async function browser() {
    if (!srv) return;
    const ok = await openUrl(srv.url);
    console.log(`${ok ? "Opened" : "Open"} Amness in your browser: ${srv.url}\nCtrl+C stops it.`);
  }
  return await new Promise<number>(() => {});
}

/** Open a running `amness serve` in the window: check it answers and the token works, then show its own page. */
async function connect(address: string, tokenArg?: string): Promise<number> {
  let u: URL; try { u = new URL(/^https?:\/\//.test(address) ? address : `http://${address}`); } catch { console.error(`amness-desktop: not an address: ${address}`); return 2; }
  const token = tokenArg ?? (/[#&]t=([^&]+)/.exec(u.hash)?.[1]) ?? process.env.AMNESS_SERVE_TOKEN;
  if (!token) { console.error("amness-desktop: give the token with --token (amness serve token, on the machine that runs it)"); return 2; }
  const base = `${u.protocol}//${u.host}/`;
  try {
    const h = await fetch(base + "v1/health", { signal: AbortSignal.timeout(8000) }); if (!h.ok) throw new Error(`HTTP ${h.status}`);
    const a = await fetch(base + "v1/sessions", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (a.status === 401) { console.error("amness-desktop: the server refused the token (amness serve token shows the right one)"); return 2; }
  } catch (e) { console.error(`amness-desktop: no amness serve answers at ${base} (${(e as Error).message})`); return 1; }
  const url = `${base}#t=${token}`, bin = argv0Browser() ? undefined : electronBinary();
  if (bin) {
    const main = fileURLToPath(new URL("./desktop/electron-main.cjs", import.meta.url)), env: NodeJS.ProcessEnv = { ...process.env, AMNESS_DESKTOP_WAIT: "1", AMNESS_DESKTOP_REMOTE: "1" };
    delete env.ELECTRON_RUN_AS_NODE; delete env.AMNESS_DESKTOP_URL;
    const child = spawn(bin, [main], { stdio: ["pipe", "ignore", "inherit"], env });
    child.stdin?.write(JSON.stringify({ url, title: `Amness · ${u.host}` }) + "\n");
    return await new Promise<number>((done) => { child.on("exit", () => done(0)); child.on("error", async () => { await openUrl(url); done(0); }); });
  }
  const ok = await openUrl(url); console.log(`${ok ? "Opened" : "Open"} ${base} in your browser (the address carries the token: keep it private)`); return 0;
}
const argv0Browser = () => process.argv.includes("--browser");

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("amness-desktop") || process.argv[1]?.endsWith("desktop.js") || process.argv[1]?.endsWith("desktop.ts")) {
  runDesktop(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`amness-desktop: ${(e as Error).message}`); process.exit(1); });
}

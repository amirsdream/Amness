// Opening a link from the chat in the user's browser. The text comes from a model (or from a web page it read), so only plain http and https links are ever opened,
// the address goes to the system opener as an argument (never through a shell), and the user has to click it.
import { spawn, type ChildProcess } from "node:child_process";

/** The URL if it is a plain web link, otherwise undefined (javascript:, file:, ftp:, a custom scheme, control characters, or no host). */
export function openableUrl(raw: string): URL | undefined {
  if (!/^https?:\/\//i.test(raw) || /[\x00-\x1f\x7f\s]/.test(raw)) return undefined;
  try { const u = new URL(raw); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u : undefined; } catch { return undefined; }
}

/** The command that opens a URL on this system. Windows uses rundll32, which takes the address as one argument; `cmd /c start` would treat & in a URL as a second command. */
export function openerFor(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Open the link. Resolves true when the system opener started and exited cleanly (or kept running for a moment), false when there is no opener (a server, a container) or it failed. */
export function openUrl(raw: string, o: { platform?: NodeJS.Platform; spawnFn?: (cmd: string, args: string[], opts: object) => ChildProcess } = {}): Promise<boolean> {
  const url = openableUrl(raw);
  if (!url) return Promise.resolve(false);
  const { cmd, args } = openerFor(url.href, o.platform);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const child = (o.spawnFn ?? spawn)(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => done(false));
      child.on("exit", (code) => done(code === 0));
      child.unref();
      setTimeout(() => done(true), 2500).unref?.();          // some openers stay running while the browser starts
    } catch { done(false); }
  });
}

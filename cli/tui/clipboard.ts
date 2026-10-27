// Copy text to the user's clipboard from a terminal app: OSC 52 (works over SSH in most modern terminals) plus the platform tool when local.
import { spawn } from "node:child_process";

export function copyToClipboard(out: { write(s: string): unknown }, text: string, local: boolean) {
  out.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  if (!local) return;
  const cmd = process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip"] : process.env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
  try { const p = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); } catch { /* no clipboard tool: OSC 52 only */ }
}

/** The bodies of the ``` fenced code blocks in a markdown string, in order. */
export function codeBlocks(md: string): string[] {
  const L = md.split("\n"), out: string[] = [];
  for (let i = 0; i < L.length; i++) {
    const f = L[i].match(/^(\s*)(`{3,}|~{3,})/); if (!f) continue;
    const body: string[] = []; for (i++; i < L.length && !/^\s*(`{3,}|~{3,})\s*$/.test(L[i]); i++) body.push(L[i].slice(Math.min(f[1].length, L[i].length - L[i].trimStart().length)));
    out.push(body.join("\n"));
  }
  return out;
}

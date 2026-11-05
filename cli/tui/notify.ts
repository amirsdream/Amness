// Telling the user something happened while they look at another window: a long turn finished, or the agent waits for approval.
// The terminal's own notification sequence is used where the terminal is known to support it (it then shows the app's name and focuses the right tab on click);
// otherwise the operating system's notifier. Sent only when the terminal is not focused (focus reporting, CSI ? 1004), so nothing pops up while you watch.
import { spawn } from "node:child_process";

export type NotifyVia = { kind: "osc9" | "osc777" | "osc99" | "os" | "none" };

/** How to notify in this terminal. iTerm2, WezTerm, Ghostty and Windows Terminal take OSC 9; kitty OSC 99; foot/urxvt OSC 777; anything else the OS notifier. */
export function notifyVia(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NotifyVia {
  const tp = (env.TERM_PROGRAM ?? "").toLowerCase(), term = (env.TERM ?? "").toLowerCase();
  if (env.AMNESS_NOTIFY === "off") return { kind: "none" };
  if (env.KITTY_WINDOW_ID || term.includes("kitty")) return { kind: "osc99" };
  if (tp === "iterm.app" || tp === "wezterm" || tp === "ghostty" || env.WT_SESSION) return { kind: "osc9" };
  if (term.startsWith("foot") || term.includes("rxvt")) return { kind: "osc777" };
  if (env.TMUX) return { kind: platform === "darwin" || platform === "linux" ? "os" : "none" };   // tmux swallows most OSC sequences
  return { kind: platform === "darwin" || platform === "linux" || platform === "win32" ? "os" : "none" };
}

const clean = (s: string) => s.replace(/[\x00-\x1f\x7f;]/g, " ").slice(0, 200);

/** The escape sequence for a terminal notification, or "" when the OS notifier is used instead. */
export function notifySequence(via: NotifyVia, title: string, body: string): string {
  const t = clean(title), b = clean(body);
  if (via.kind === "osc9") return `\x1b]9;${t}: ${b}\x07`;
  if (via.kind === "osc777") return `\x1b]777;notify;${t};${b}\x07`;
  if (via.kind === "osc99") return `\x1b]99;i=1:d=0;${t}\x1b\\\x1b]99;i=1:d=1:p=body;${b}\x1b\\`;
  return "";
}

/** Show a notification. `out` is the terminal; the OS notifier runs detached and its failure is ignored. */
export function notify(out: { write(s: string): unknown }, title: string, body: string, via = notifyVia()) {
  if (via.kind === "none") return;
  const seq = notifySequence(via, title, body); if (seq) { out.write(seq); return; }
  const t = clean(title), b = clean(body);
  const cmd = process.platform === "darwin" ? ["osascript", ["-e", `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)}`]]
    : process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-Command", `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${t.replace(/'/g, "''")}', '${b.replace(/'/g, "''")}', 'None'); Start-Sleep 6; $n.Dispose()`]]
    : ["notify-send", ["--app-name=Amness", t, b]];
  try { const p = spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }); p.on("error", () => {}); p.unref(); } catch { /* no notifier */ }
}

export const FOCUS_ON = "\x1b[?1004h", FOCUS_OFF = "\x1b[?1004l";

// Which shell runs the agent's commands. The best choice depends on the machine, so Amness looks at what exists:
//   macOS / Linux: bash, else zsh, else sh (the model writes bash; your login shell is not used unless you ask for it).
//   Windows: the bash that comes with Git for Windows, else PowerShell 7 (pwsh), else Windows PowerShell, else cmd.exe.
// The model is told which shell it is talking to (a PowerShell command is not a bash command), and the safety floor knows the dangerous commands of each family.
// Override with the AMNESS_SHELL environment variable, the `shell` setting, or /shell: auto, bash, zsh, sh, pwsh, powershell or cmd.
import { existsSync } from "node:fs";
import { delimiter, join as joinHere, win32 } from "node:path";
const jn = (win: boolean) => (win ? win32.join : joinHere);

export type ShellKind = "posix" | "powershell" | "cmd";
export type ShellInfo = { name: string; kind: ShellKind; file: string; /** how the shell is started with one command line */ args: (cmd: string) => string[] };
const WANT = ["auto", "bash", "zsh", "sh", "pwsh", "powershell", "cmd"] as const;
export const SHELL_CHOICES: readonly string[] = WANT;

type Probe = { platform: NodeJS.Platform; env: Record<string, string | undefined>; exists: (f: string) => boolean };
const real: Probe = { platform: process.platform, get env() { return process.env; }, exists: existsSync };
const exe = (n: string, win: boolean) => (win && !/\.(exe|cmd|bat)$/i.test(n) ? n + ".exe" : n);
/** Find a program on PATH (never the WSL launcher in System32, which sees another filesystem). */
function onPath(name: string, p: Probe): string | undefined {
  const win = p.platform === "win32", dirs = (p.env.PATH ?? p.env.Path ?? "").split(win ? ";" : delimiter).filter(Boolean);
  for (const d of dirs) { const f = jn(win)(d, exe(name, win)); if (p.exists(f) && !(win && name === "bash" && /system32/i.test(f))) return f; }
  return undefined;
}
function gitBash(p: Probe): string | undefined {
  const join = jn(p.platform === "win32");
  const fromPath = onPath("bash", p); if (fromPath) return fromPath;
  for (const base of [p.env.ProgramFiles, p.env["ProgramFiles(x86)"], p.env.LOCALAPPDATA && jn(true)(p.env.LOCALAPPDATA, "Programs")]) if (base) for (const sub of [join("Git", "bin", "bash.exe"), join("Git", "usr", "bin", "bash.exe")]) { const f = join(base, sub); if (p.exists(f)) return f; }
  return undefined;
}
const posix = (name: string, file: string): ShellInfo => ({ name, kind: "posix", file, args: (cmd) => ["-c", cmd] });
const ps = (name: string, file: string): ShellInfo => ({ name, kind: "powershell", file, args: (cmd) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd] });
const cmdShell = (file: string): ShellInfo => ({ name: "cmd", kind: "cmd", file, args: (cmd) => ["/d", "/s", "/c", cmd] });

/** Pick a shell. `want` is "auto" or a name; a name that is not installed falls back to auto (and `fallback` says so). Pure apart from the probe, so it is testable. */
export function chooseShell(want: string = "auto", p: Probe = real): { shell: ShellInfo; fallback?: string } {
  const win = p.platform === "win32";
  const find = (n: string): ShellInfo | undefined => {
    if (n === "cmd") return win ? cmdShell(p.env.ComSpec ?? "cmd.exe") : undefined;
    if (n === "pwsh") { const f = onPath("pwsh", p); return f ? ps("pwsh", f) : undefined; }
    if (n === "powershell") { const f = onPath("powershell", p) ?? (win && p.env.SystemRoot && p.exists(win32.join(p.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")) ? win32.join(p.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined); return f ? ps("powershell", f) : undefined; }
    if (n === "bash" && win) { const f = gitBash(p); return f ? posix("bash", f) : undefined; }
    const f = onPath(n, p) ?? (!win && p.exists("/bin/" + n) ? "/bin/" + n : undefined); return f ? posix(n, f) : undefined;
  };
  let fallback: string | undefined;
  if (want !== "auto") { const s = find(want); if (s) return { shell: s }; fallback = `${want} was asked for but is not installed here; using the automatic choice`; }
  if (win) { const s = find("bash") ?? find("pwsh") ?? find("powershell") ?? find("cmd") ?? cmdShell("cmd.exe"); return { shell: s, fallback }; }
  // bash first (it is what models write), then zsh, then sh. Your login shell is deliberately not used by default: commands should behave the same on every machine; ask for zsh with /shell zsh.
  const s = find("bash") ?? find("zsh") ?? find("sh") ?? posix("sh", "/bin/sh");
  return { shell: s, fallback };
}

let wanted = "auto", cached: ReturnType<typeof chooseShell> | undefined;
/** Set the preferred shell (from config or /shell). Anything else than a known name is ignored. */
export function setShell(name: string | undefined) { const n = (name ?? "auto").toLowerCase(); wanted = (WANT as readonly string[]).includes(n) ? n : "auto"; cached = undefined; }
export function currentShell(): ShellInfo { return (cached ??= chooseShell(process.env.AMNESS_SHELL ?? wanted)).shell; }
export const shellFallbackNote = () => (cached ??= chooseShell(process.env.AMNESS_SHELL ?? wanted)).fallback;
/** The program and arguments that run one command line in the current shell. */
export const shellInvocation = (cmd: string): { file: string; args: string[] } => { const s = currentShell(); return { file: s.file, args: s.args(cmd) }; };
/** Kept for older callers: the path of the current shell program. */
export const posixShell = (): string => currentShell().file;

/** What to tell the model about where its commands run. */
export function shellNote(p: Probe = real): string {
  const s = chooseShell(process.env.AMNESS_SHELL ?? wanted, p).shell, os = p.platform === "win32" ? "Windows" : p.platform === "darwin" ? "macOS" : p.platform === "linux" ? "Linux" : p.platform;
  if (s.kind === "powershell") return `Environment: ${os}. Commands run in PowerShell (${s.name}), not bash: use PowerShell syntax (Get-ChildItem, Select-String, Get-Content, $env:NAME, \`;\` to chain commands). Forward slashes work in paths. Tools like grep, ls and cat may not exist.`;
  if (s.kind === "cmd") return `Environment: ${os}. Commands run in cmd.exe, not bash: use cmd syntax (dir, type, set NAME=value, & to chain commands). Tools like grep, ls and cat do not exist.`;
  return `Environment: ${os}. Commands run with ${s.name} (${s.name} -c "<cmd>"): use ${s.name === "sh" || s.name === "dash" ? "POSIX sh" : s.name} syntax.`;
}
/** The path as the model should see it: always forward slashes. */
export const slash = (p: string) => p.replace(/\\/g, "/");

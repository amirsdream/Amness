// Which shell runs commands. Tool descriptions, permission rules and hooks all assume a POSIX shell, so on Windows we use the bash that ships with Git for Windows
// (or any bash on PATH) instead of cmd.exe. If none is found, commands fail with a clear message rather than running under different rules.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

let cached: string | undefined;
export function posixShell(): string {
  if (process.platform !== "win32") return "sh";
  if (cached) return cached;
  const candidates = [...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, "bash.exe")), ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean).map((d) => join(d!, "Git", "bin", "bash.exe"))];
  // C:\Windows\System32\bash.exe is the WSL launcher, which sees a different filesystem: skip it
  return (cached = candidates.find((c) => existsSync(c) && !/system32/i.test(c)) ?? "bash");
}
/** The path as the model should see it: always forward slashes. */
export const slash = (p: string) => p.replace(/\\/g, "/");

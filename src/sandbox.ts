// OS-level sandbox for shell commands. The permission prompts are a policy; this is enforcement: even an approved or auto-approved command cannot write outside
// the workspace (or into .git), and in strict mode cannot use the network. macOS: Seatbelt (sandbox-exec). Linux: Bubblewrap (bwrap). Elsewhere: unavailable, and
// asking for a sandbox that cannot be provided is an error, never a silent downgrade.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type SandboxMode = "off" | "workspace" | "strict";
export type SandboxKind = "seatbelt" | "bwrap";
export const SANDBOX_MODES: SandboxMode[] = ["off", "workspace", "strict"];

let cached: SandboxKind | undefined | null = null;
const has = (bin: string) => { try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; } };
/** bwrap is often installed but unable to create namespaces (containers, locked-down kernels): probe with a no-op instead of trusting `command -v`. */
function bwrapWorks(): boolean { try { execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; } }
/** Which sandbox this machine can provide. */
export function sandboxKind(): SandboxKind | undefined {
  if (cached === null) cached = process.platform === "darwin" && has("sandbox-exec") ? "seatbelt" : process.platform === "linux" && has("bwrap") && bwrapWorks() ? "bwrap" : undefined;
  return cached;
}
export const sandboxHelp = () => process.platform === "linux" ? "install bubblewrap (apt install bubblewrap); if it is installed, this kernel or container does not allow it to create namespaces" : process.platform === "darwin" ? "sandbox-exec was not found" : "OS sandboxing is only available on macOS and Linux";

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Folders that tools legitimately write to besides the workspace: temp folders and package-manager caches (not in strict mode). */
function writable(workspace: string, mode: SandboxMode): string[] {
  const h = homedir(), base = [workspace, tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders", "/dev/shm"];
  const caches = [".npm", ".cache", ".cargo", ".rustup", ".gradle", ".m2", ".pnpm-store", ".yarn", ".bun", ".deno", "go/pkg", ".local/share", "Library/Caches", ".node-gyp", ".config"].map((d) => join(h, d));
  return [...new Set([...base, ...(mode === "workspace" ? caches : [])].map(real))].filter((p) => existsSync(p));
}
const q = (s: string) => JSON.stringify(s);   // SBPL string literals use the same quoting as JSON for the characters that matter here

/** The Seatbelt profile: everything allowed except writing outside the allowed folders (and inside .git), and, in strict mode, the network. */
export function seatbeltProfile(workspace: string, mode: SandboxMode): string {
  const ws = real(workspace), dirs = writable(ws, mode);
  return [
    "(version 1)", "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${dirs.map((d) => `(subpath ${q(d)})`).join(" ")} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(fd|pts|tty)")` + ")",
    `(deny file-write* (subpath ${q(join(ws, ".git"))}) (regex #"^${join(ws, ".amness").replace(/[.+*?^${}()|[\]\\]/g, "\\$&")}/(hooks|permissions)\\.json$"))`,
    ...(mode === "strict" ? ["(deny network*)", "(allow network* (local unix))"] : []),
  ].join("\n");
}

/** `file` and `args` that run `cmd` under the sandbox, or undefined when mode is off. Throws when a sandbox was asked for and cannot be provided. */
export function wrapCommand(cmd: string, workspace: string, mode: SandboxMode): { file: string; args: string[] } | undefined {
  if (mode === "off") return undefined;
  const kind = sandboxKind();
  if (!kind) throw new Error(`the sandbox is on (${mode}) but unavailable here: ${sandboxHelp()}. Turn it off with /sandbox off to run commands unsandboxed.`);
  if (kind === "seatbelt") return { file: "sandbox-exec", args: ["-p", seatbeltProfile(workspace, mode), "sh", "-c", cmd] };
  const ws = real(workspace), dirs = writable(ws, mode);
  return { file: "bwrap", args: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...dirs.flatMap((d) => ["--bind", d, d]), ...(existsSync(join(ws, ".git")) ? ["--ro-bind", join(ws, ".git"), join(ws, ".git")] : []),
    ...(mode === "strict" ? ["--unshare-net"] : []), "--die-with-parent", "--chdir", ws, "sh", "-c", cmd] };
}

// OS-level sandbox for shell commands. The permission prompts are a policy; this is enforcement: even an approved or auto-approved command cannot write outside
// the workspace (or into .git), and in strict mode cannot use the network. macOS: Seatbelt (sandbox-exec). Linux: Bubblewrap (bwrap). Elsewhere: unavailable, and
// asking for a sandbox that cannot be provided is an error, never a silent downgrade.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type SandboxMode = "off" | "workspace" | "strict";
/** A sandbox engine's name: "seatbelt", "bwrap", "docker", or one a plugin registered. */
export type SandboxKind = string;
/** A way to run shell commands confined: built in (Seatbelt, Bubblewrap, Docker) or added by a plugin (for example Sandlock, Landlock, a remote VM). */
export type SandboxBackend = {
  name: string; label?: string;
  /** Why it cannot run on this machine, or undefined when it can. */
  unavailable(): string | undefined;
  /** The program and arguments that run `cmd` in `workspace` under `mode` (never "off"). */
  wrap(cmd: string, workspace: string, mode: Exclude<SandboxMode, "off">): { file: string; args: string[] };
};
export const SANDBOX_MODES: SandboxMode[] = ["off", "workspace", "strict"];

let cached: SandboxKind | undefined | null = null;
const has = (bin: string) => { try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; } };
/** bwrap is often installed but unable to create namespaces (containers, locked-down kernels): probe with a no-op instead of trusting `command -v`. */
function bwrapWorks(): boolean { try { execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; } }
/** The OS sandbox this machine provides (Seatbelt on macOS, Bubblewrap on Linux), whatever engine is chosen. */
function osKind(): "seatbelt" | "bwrap" | undefined {
  if (cached === null) cached = process.platform === "darwin" && has("sandbox-exec") ? "seatbelt" : process.platform === "linux" && has("bwrap") && bwrapWorks() ? "bwrap" : undefined;
  return cached as "seatbelt" | "bwrap" | undefined;
}
/** The engine that will run sandboxed commands now (the chosen one, or the OS sandbox for "auto"), or undefined when it cannot run here. */
export function sandboxKind(): SandboxKind | undefined {
  if (chosen === "auto") return osKind();
  const b = backends.get(chosen); return b && !b.unavailable() ? b.name : undefined;
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

// ------------------------------------------------------------------ engines
const backends = new Map<string, SandboxBackend>();
let chosen = "auto";
/** Add an engine (plugins do this); a later one with the same name replaces the earlier. */
export function registerSandbox(b: SandboxBackend) { backends.set(b.name, b); }
/** Every engine, built in and registered, with whether it can run here. */
export function sandboxBackends(): { name: string; label: string; unavailable?: string }[] { return [...backends.values()].map((b) => ({ name: b.name, label: b.label ?? b.name, unavailable: b.unavailable() })); }
/** Choose the engine for every sandboxed command in this process: "auto" (the OS sandbox) or an engine's name. Unknown names are an error. */
export function setSandboxBackend(name = "auto") { if (name !== "auto" && !backends.has(name)) throw new Error(`no sandbox engine "${name}" (engines: auto, ${[...backends.keys()].join(", ")})`); chosen = name; }
export const sandboxBackendName = () => chosen;

registerSandbox({ name: "seatbelt", label: "Seatbelt (macOS)", unavailable: () => (osKind() === "seatbelt" ? undefined : "macOS only (sandbox-exec)"),
  wrap: (cmd, ws, mode) => ({ file: "sandbox-exec", args: ["-p", seatbeltProfile(ws, mode), "sh", "-c", cmd] }) });
registerSandbox({ name: "bwrap", label: "Bubblewrap (Linux)", unavailable: () => (osKind() === "bwrap" ? undefined : process.platform === "linux" ? sandboxHelp() : "Linux only (bubblewrap)"),
  wrap: (cmd, workspace, mode) => { const ws = real(workspace), dirs = writable(ws, mode);
    return { file: "bwrap", args: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...dirs.flatMap((d) => ["--bind", d, d]), ...(existsSync(join(ws, ".git")) ? ["--ro-bind", join(ws, ".git"), join(ws, ".git")] : []),
      ...(mode === "strict" ? ["--unshare-net"] : []), "--die-with-parent", "--chdir", ws, "sh", "-c", cmd] }; } });

/** Settings of the Docker engine: the image the commands run in, and an optional runtime (`runsc` = gVisor, a user-space kernel, for stronger isolation). */
export const dockerSandbox = { image: process.env.AMNESS_SANDBOX_IMAGE || "node:22-bookworm", runtime: process.env.AMNESS_SANDBOX_RUNTIME || "" };
let dockerOk: boolean | undefined;
registerSandbox({ name: "docker", label: "Docker container (optionally gVisor)",
  unavailable: () => { if (dockerOk === undefined) { try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 8000 }); dockerOk = true; } catch { dockerOk = false; } } return dockerOk ? undefined : "Docker is not running (or not installed)"; },
  // A throwaway container per command: the project is mounted at the same path (so paths in output match), .git read-only; nothing else of the host is visible.
  wrap: (cmd, workspace, mode) => ({ file: "docker", args: dockerArgs(cmd, workspace, mode) }) });
/** The `docker run` arguments for one sandboxed command. */
export function dockerArgs(cmd: string, workspace: string, mode: Exclude<SandboxMode, "off">, platform = process.platform): string[] {
  // The containers are Linux: on Windows a C:\ path cannot be the same path inside, so the project is mounted at /workspace there (paths in the output then differ).
  const ws = real(workspace), inside = platform === "win32" ? "/workspace" : ws;
  return ["run", "--rm", "-i", ...(dockerSandbox.runtime ? ["--runtime", dockerSandbox.runtime] : []), ...(mode === "strict" ? ["--network", "none"] : []),
    "-v", `${ws}:${inside}`, ...(existsSync(join(ws, ".git")) ? ["-v", `${join(ws, ".git")}:${inside}/.git:ro`] : []), "-w", inside, dockerSandbox.image, "sh", "-c", cmd];
}

/** `file` and `args` that run `cmd` under the sandbox, or undefined when mode is off. Throws when a sandbox was asked for and cannot be provided (never a silent downgrade). */
export function wrapCommand(cmd: string, workspace: string, mode: SandboxMode): { file: string; args: string[] } | undefined {
  if (mode === "off") return undefined;
  const b = chosen === "auto" ? (osKind() ? backends.get(osKind()!) : undefined) : backends.get(chosen);
  const why = b ? b.unavailable() : sandboxHelp();
  if (!b || why) throw new Error(`the sandbox is on (${mode}${chosen === "auto" ? "" : `, engine ${chosen}`}) but unavailable here: ${why}. Choose another engine, or turn it off with /sandbox off to run commands unsandboxed.`);
  return b.wrap(cmd, workspace, mode);
}

/** Apply a config's engine settings (sandboxEngine, sandboxImage, sandboxRuntime). Returns false, and says why, when the engine is unknown. */
export function applySandboxEngine(c: { sandboxEngine?: string; sandboxImage?: string; sandboxRuntime?: string }, say: (m: string) => void = () => {}): boolean {
  if (c.sandboxImage) dockerSandbox.image = c.sandboxImage;
  if (c.sandboxRuntime !== undefined) dockerSandbox.runtime = c.sandboxRuntime;
  try { setSandboxBackend(c.sandboxEngine || "auto"); return true; } catch (e) { say(`sandbox engine: ${(e as Error).message}; using auto`); setSandboxBackend("auto"); return false; }
}

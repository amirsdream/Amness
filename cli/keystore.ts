// Where API keys live. macOS: the login Keychain. Linux: the desktop secret service (`secret-tool`). Windows: DPAPI, which encrypts the key so only your Windows user on this machine can decrypt it.
// If the OS store is missing or refuses (a Linux server or Docker image with no keyring), the key stays in the config file with mode 600, and `where()` says so.
// The key goes to the OS tool on stdin, never on the command line (a command line is visible to other users in `ps`), and is hex-encoded so no quoting can go wrong.
// Tests and any run with a custom AMNESS_HOME use the file, so they never touch your real store. AMNESS_KEYSTORE=file|keychain|secret-service|dpapi|none forces one.
// In a container (Docker, Kubernetes) nothing is saved at all ("none"): pass the key as an environment variable or a secret file (see config.ts), so it is never written into an image or a volume.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE = process.env.AMNESS_KEYSTORE_SERVICE || "amness"; // the override is for tests
export type Backend = "keychain" | "secret-service" | "dpapi" | "file" | "none";

const run = (cmd: string, args: string[], input?: string, timeout = 10_000, env?: NodeJS.ProcessEnv) => {
  try { const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout, env }); return r.error ? undefined : r; } catch { return undefined; }
};

export function backend(): Backend {
  const want = process.env.AMNESS_KEYSTORE;
  if (want === "file" || (!want && process.env.AMNESS_HOME)) return "file";
  if (want === "keychain" || want === "secret-service" || want === "dpapi" || want === "none") return want;
  if (process.platform === "linux" && (existsSync("/.dockerenv") || process.env.KUBERNETES_SERVICE_HOST)) return "none";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "win32") return "dpapi";
  if (process.platform === "linux" && run("secret-tool", ["--version"])?.status !== undefined) return "secret-service";
  return "file";
}

export const where = (): string => ({ keychain: "saved in the macOS Keychain", "secret-service": "saved in the system keyring (secret-tool)", dpapi: "saved with Windows encryption (DPAPI, this user only)", file: "saved in ~/.amness/config.json, mode 600, not encrypted", none: "not saved: this is a container, so pass the key as an environment variable or a secret file (OPENAI_API_KEY_FILE / ANTHROPIC_API_KEY_FILE)" })[backend()];
/** True when keys must never be written to disk (containers). */
export const noStore = (): boolean => backend() === "none";

// Windows: PowerShell turns the key into an encrypted string that only this Windows user on this machine can decrypt (DPAPI). The string is kept in ~/.amness/secrets/<name>.dpapi.
const dir = () => join(process.env.AMNESS_HOME ?? join(homedir(), ".amness"), "secrets");
const blob = (name: string) => join(dir(), `${name}.dpapi`);
// A parent PowerShell 7 (pwsh) leaves a PSModulePath that Windows PowerShell 5.1 cannot load its Security module from; dropping it lets 5.1 use its own default.
const psEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toLowerCase() === "psmodulepath") delete e[k]; return e; };
const ps = (script: string, input: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], input, 60_000, psEnv()); // Windows PowerShell can take several seconds to start
const PS_ENCRYPT = "$p = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString";
const PS_DECRYPT = "$e = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $e; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const unhex = (s: string) => Buffer.from(s.trim(), "hex").toString("utf8");

/** Save a secret. Returns false when the OS store is not available or refused, so the caller can fall back to the file. */
export function setSecret(name: string, value: string): boolean {
  const b = backend(); if (b === "file" || b === "none") return false;
  if (b === "dpapi") {
    const r = ps(PS_ENCRYPT, hex(value));
    if (r?.status !== 0 || !r.stdout.trim()) return false;
    try { mkdirSync(dir(), { recursive: true }); writeFileSync(blob(name), r.stdout.trim(), { mode: 0o600 }); } catch { return false; }
    return getSecret(name) === value;
  }
  if (b === "keychain") {
    const r = run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${name} -w ${hex(value)}\n`);
    return r?.status === 0 && !/error|fail/i.test(r.stderr ?? "") && getSecret(name) === value;
  }
  const r = run("secret-tool", ["store", `--label=amness ${name}`, "service", SERVICE, "account", name], hex(value));
  return r?.status === 0 && getSecret(name) === value;
}

export function getSecret(name: string): string | undefined {
  const b = backend(); if (b === "file" || b === "none") return undefined;
  if (b === "dpapi") {
    if (!existsSync(blob(name))) return undefined;
    const r = ps(PS_DECRYPT, readFileSync(blob(name), "utf8"));
    const v = r?.status === 0 ? unhex(r.stdout) : ""; return v || undefined;
  }
  const r = b === "keychain" ? run("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]) : run("secret-tool", ["lookup", "service", SERVICE, "account", name]);
  if (r?.status !== 0 || !r.stdout.trim()) return undefined;
  const v = unhex(r.stdout); return v || undefined;
}

export function deleteSecret(name: string): void {
  const b = backend(); if (b === "file" || b === "none") return;
  if (b === "dpapi") { try { rmSync(blob(name), { force: true }); } catch { /* already gone */ } return; }
  if (b === "keychain") run("security", ["delete-generic-password", "-s", SERVICE, "-a", name]);
  else run("secret-tool", ["clear", "service", SERVICE, "account", name]);
}

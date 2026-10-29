// Permission rules and a hard floor. Rules live in .amness/permissions.json (project) and ~/.amness/permissions.json (yours):
//   { "allow": ["sh(npm test*)", "edit(src/**)"], "ask": ["sh(git commit*)"], "deny": ["sh(git push*)", "edit(.env)"] }
// Order of precedence: floor > deny > ask > allow > the permission mode. The floor holds in EVERY mode, yolo included.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { patchPaths } from "./patch.ts";

export type PermConfig = { allow?: string[]; ask?: string[]; deny?: string[] };
export type Verdict = { action: "allow" | "ask" | "deny" | "none"; rule?: string; reason?: string; /** came from the built-in floor: session shortcuts must not bypass it */ floor?: boolean };
export type PermissionChecker = { check(tool: string, args: Record<string, any>): Verdict };

const SHELL = new Set(["sh", "sh_start"]), EDIT = new Set(["edit_file", "write_file", "apply_patch"]), READ = new Set(["read_file", "grep", "list_files"]);
const kindOf = (tool: string) => (SHELL.has(tool) ? "sh" : EDIT.has(tool) ? "edit" : READ.has(tool) ? "read" : tool);

/** `*` matches within a path segment... except in commands, where it matches anything; `**` crosses folders. */
const glob = (pat: string, loose: boolean): RegExp => {
  const re = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, loose ? ".*" : "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, loose ? "." : "[^/]");
  return new RegExp(`^${re}$`, "s");
};
const parseRule = (r: string): { kind: string; pat?: string } | undefined => { const m = /^([\w:.-]+?)(?:\((.*)\))?$/s.exec(r.trim()); return m ? { kind: m[1], pat: m[2] } : undefined; };

/** Split a shell command into the commands it runs. Quotes are respected; anything we cannot reason about (subshells, backticks) is reported. */
export function splitCommand(cmd: string): { parts: string[]; opaque: boolean } {
  const parts: string[] = []; let cur = "", q = "", opaque = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) { if (c === q) q = ""; else if (c === "\\" && q === '"') { cur += c + (n ?? ""); i++; continue; } else if (q === '"' && (c === "`" || (c === "$" && n === "("))) opaque = true; cur += c; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "\\") { cur += c + (n ?? ""); i++; continue; }
    if (c === "`" || (c === "$" && n === "(") || ((c === "<" || c === ">") && n === "(")) opaque = true;
    if (c === ";" || c === "\n" || c === "|" || c === "&") { if (cur.trim()) parts.push(cur.trim()); cur = ""; if ((c === "|" || c === "&") && n === c) i++; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return { parts, opaque };
};

/** A command the way the shell will see it, for detection: quotes and backslash escapes inside words removed (r""m, r\m, "rm"), $'\x72m' decoded, ${IFS} turned into a space. Never used to RUN anything. */
export function normalizeCommand(cmd: string): string {
  let s = cmd.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, body: string) => body.replace(/\\x([0-9a-fA-F]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\([0-7]{1,3})/g, (_x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1"));
  s = s.replace(/\$\{IFS\}|\$IFS/g, " ");
  return s.replace(/\\(?=[A-Za-z0-9_./~-])/g, "").replace(/(["'])\1/g, "").replace(/["']/g, "");
}
/** The command plus every other form it may take: normalised, and the text of nested `sh -c '...'`, `bash -c "..."` and `eval "..."` (recursively). All of them are checked against the floor and the risk list. */
export function commandViews(cmd: string, depth = 0): string[] {
  const views = new Set<string>([cmd, normalizeCommand(cmd)]);
  if (depth < 3) for (const m of cmd.matchAll(/\b(?:ba|z|da|k)?sh\s+(?:-\w*c\w*)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')|\beval\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g)) { const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]; if (inner) for (const v of commandViews(inner, depth + 1)) views.add(v); }
  return [...views];
}
/** Decoding a payload and running it is how checks get dodged; it always deserves a human look. */
export const OBFUSCATED_EXEC = /\b(?:base64|b64decode|xxd\s+-r|openssl\s+(?:enc|base64)\b)[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\beval\s+["']?\$\(|\b(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)|\bpython3?\s+-c\s+["'][^"']*(?:base64|exec\(|__import__)/;

// ---- the floor: refused or always-asked, whatever the mode ------------------------------------------------------------------------------
const PROTECTED = /(^|\/)\.amness\/(hooks|permissions)\.json$/;
const FLOOR_DENY: [RegExp, string][] = [
  [/\brm\s+(?:-\S+\s+)*-\S*[rRf]\S*\s+(?:-\S+\s+)*(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\.\.(?:\/\S*)?)(?=\s|$)/, "recursive delete of the root, your home folder or a parent folder"],
  [/(?:^|[\s;&|])(?:sudo\s+)?mkfs(?:\.\w+)?\b/, "formatting a filesystem"],
  [/\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|disk|hd|mmcblk)/, "writing raw data to a disk device"],
  [/>\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk)/, "writing to a disk device"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "a fork bomb"],
  [/\bchmod\s+-R\s+0?777\s+\/(?:\s|$)/, "making the whole filesystem world-writable"],
  [/\bgit\s+(?:-\S+\s+)*push\b[^|;&]*\s(?:--force(?!-with-lease)|-f)\b[^|;&]*\b(?:main|master)\b/, "force-pushing to main or master"],
  // Windows families (PowerShell and cmd): the same kinds of damage
  [/\b(?:Remove-Item|ri|rm|del|erase)\b[^|;&\n]*-Recurse\b[^|;&\n]*(?:\s|['"])(?:[A-Za-z]:[\\/]?(?=\s|['"]|$)|[\\/](?=\s|['"]|$)|~(?=[\\/]?(?:\s|['"]|$))|\$HOME\b|\$env:(?:USERPROFILE|HOMEPATH|SystemRoot|SystemDrive)\b)/i, "recursive delete of a drive, your home folder or the system folder"],
  [/\b(?:rd|rmdir|del|erase)\s+(?:\/[a-z]\s+)*\/s\b[^&|\n]*\s(?:[A-Za-z]:[\\/]?(?:\*(?:\.\*)?)?|%(?:USERPROFILE|HOMEPATH|SystemRoot|SystemDrive)%)(?=\s|$)/i, "recursive delete of a drive, your home folder or the system folder"],
  [/\bFormat-Volume\b|\bformat(?:\.com)?\s+[A-Za-z]:(?=\s|$)|\bClear-Disk\b|\bInitialize-Disk\b/i, "formatting or wiping a disk"],
];
const FLOOR_ASK: [RegExp, string][] = [
  [/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, "downloads and runs a script"],
  [/\bgit\s+(?:-\S+\s+)*push\b[^|;&]*\s(?:--force|--force-with-lease|-f)\b/, "force-pushes"],
  [/\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^|;\n]*\|\s*(?:Invoke-Expression|iex)\b/i, "downloads and runs a script"],
  [/(?:^|[\s;&|])-(?:EncodedCommand|enc|ec)\s+\S+|\bFromBase64String\b[^;\n]*\b(?:Invoke-Expression|iex)\b/i, "runs an encoded command"],
];
const WRITES_PROTECTED = /\.amness\/(?:hooks|permissions)\.json/;
const READONLY_VERB = /^\s*(?:cat|head|tail|less|grep|rg|ls|wc|stat|file|diff)\b/;

/** The text of an apply_patch call: inline, or read from the patch file it names (so rules and the floor see the real paths). */
const patchOf = (args: Record<string, any>, cwd: string): string => { if (typeof args.patch === "string") return args.patch; try { return typeof args.file === "string" ? readFileSync(resolve(cwd, args.file), "utf8") : ""; } catch { return ""; } };

export function floorCheck(tool: string, args: Record<string, any>, cwd: string): Verdict {
  if (tool === "apply_patch") { for (const p of patchPaths(patchOf(args, cwd))) { const v = floorCheck("edit_file", { path: p }, cwd); if (v.action !== "none") return v; } return { action: "none" }; }
  const kind = kindOf(tool);
  if (kind === "edit" && typeof args.path === "string") {
    const rel = relative(cwd, resolve(cwd, args.path)).split("\\").join("/");
    if (rel === ".git" || rel.startsWith(".git/")) return { action: "deny", floor: true, reason: "the .git folder is protected: change history with git commands you can see, not by editing its files" };
    if (PROTECTED.test(rel)) return { action: "deny", floor: true, reason: "the agent may not edit its own hooks or permission rules" };
  }
  if (kind === "sh" && typeof args.cmd === "string") {
    const cmd: string = args.cmd;
    if (WRITES_PROTECTED.test(cmd) && !splitCommand(cmd).parts.every((p) => READONLY_VERB.test(p))) return { action: "deny", floor: true, reason: "the agent may not change its own hooks or permission rules" };
    const views = commandViews(cmd);
    for (const [re, why] of FLOOR_DENY) if (views.some((v) => re.test(v))) return { action: "deny", floor: true, reason: why };
    for (const [re, why] of FLOOR_ASK) if (views.some((v) => re.test(v))) return { action: "ask", floor: true, reason: why };
    if (OBFUSCATED_EXEC.test(cmd) || OBFUSCATED_EXEC.test(views[1] ?? "")) return { action: "ask", floor: true, reason: "decodes or downloads a payload and runs it" };
  }
  return { action: "none" };
}

const readCfg = (file: string): PermConfig => {
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, "utf8")) as PermConfig, out: PermConfig = {};
  for (const k of ["allow", "ask", "deny"] as const) {
    const l = j[k]; if (l === undefined) continue;
    if (!Array.isArray(l) || l.some((x) => typeof x !== "string" || !parseRule(x))) throw new Error(`${file}: "${k}" must be a list of rules like "sh(npm test*)" or "edit(src/**)"`);
    out[k] = l;
  }
  return out;
};

export class Permissions implements PermissionChecker {
  private cfg: Required<PermConfig>; private cwd: string;
  constructor(cfg: PermConfig, cwd: string) { this.cfg = { allow: cfg.allow ?? [], ask: cfg.ask ?? [], deny: cfg.deny ?? [] }; this.cwd = resolve(cwd); }
  static projectFile(cwd: string) { return join(cwd, ".amness", "permissions.json"); }
  /** `deny` and `ask` from any file always apply (they only restrict); `allow` from a project file needs `trustProject`, since it removes prompts. */
  static load(cwd: string, o: { trustProject?: boolean; userDir?: string } = {}): Permissions {
    const user = readCfg(join(o.userDir ?? process.env.AMNESS_HOME ?? join(homedir(), ".amness"), "permissions.json")), proj = readCfg(Permissions.projectFile(cwd));
    return new Permissions({ allow: [...(user.allow ?? []), ...(o.trustProject ? proj.allow ?? [] : [])], ask: [...(user.ask ?? []), ...(proj.ask ?? [])], deny: [...(user.deny ?? []), ...(proj.deny ?? [])] }, cwd);
  }
  /** Append a rule to the project file (used by the approval dialog and `/permissions`). */
  static addProjectRule(cwd: string, list: "allow" | "ask" | "deny", rule: string) {
    if (!parseRule(rule)) throw new Error(`not a rule: ${rule}`);
    const f = Permissions.projectFile(cwd); let cur: PermConfig = {}; try { cur = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { /* start fresh */ }
    cur[list] = [...new Set([...(cur[list] ?? []), rule])];
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(cur, null, 2) + "\n");
  }
  rules() { return this.cfg; }

  private matches(rule: string, tool: string, args: Record<string, any>): boolean {
    const r = parseRule(rule); if (!r) return false;
    const kind = kindOf(tool);
    if (r.kind !== kind && r.kind !== tool) return false;
    if (r.pat === undefined) return true;
    if (kind === "sh") return typeof args.cmd === "string" && glob(r.pat, true).test(args.cmd.trim());
    const p = typeof args.path === "string" ? args.path : typeof args.pattern === "string" ? args.pattern : undefined;
    if (p !== undefined && (kind === "edit" || kind === "read")) { const rel = relative(this.cwd, isAbsolute(p) ? p : resolve(this.cwd, p)).split("\\").join("/"); return glob(r.pat, false).test(rel) || glob(r.pat, false).test(p); }
    return glob(r.pat, true).test(JSON.stringify(args));
  }
  /** Per-command matching for shell: a compound command is checked piece by piece. */
  private anyMatch(list: string[], tool: string, args: Record<string, any>): string | undefined {
    if (kindOf(tool) === "sh" && typeof args.cmd === "string") {
      const { parts } = splitCommand(args.cmd);
      return list.find((rule) => this.matches(rule, tool, args) || parts.some((p) => this.matches(rule, tool, { ...args, cmd: p })));
    }
    return list.find((r) => this.matches(r, tool, args));
  }

  check(tool: string, args: Record<string, any>): Verdict {
    if (tool === "apply_patch") {        // a patch is judged file by file: any denied file denies it, any "ask" asks, and it is only allowed when every file is
      const paths = patchPaths(patchOf(args, this.cwd)), per = paths.map((p) => this.check("edit_file", { path: p }));
      return per.find((v) => v.action === "deny") ?? per.find((v) => v.action === "ask") ?? (per.length && per.every((v) => v.action === "allow") ? { action: "allow", rule: per[0].rule } : { action: "none" });
    }
    const floor = floorCheck(tool, args, this.cwd); if (floor.action !== "none") return floor;
    const deny = this.anyMatch(this.cfg.deny, tool, args); if (deny) return { action: "deny", rule: deny, reason: `denied by your permission rule \`${deny}\`` };
    const ask = this.anyMatch(this.cfg.ask, tool, args); if (ask) return { action: "ask", rule: ask, reason: `matches your rule \`${ask}\`, which requires approval` };
    if (kindOf(tool) === "sh" && typeof args.cmd === "string") {
      const { parts, opaque } = splitCommand(args.cmd);
      if (!opaque && parts.length && parts.every((p) => this.cfg.allow.some((r) => this.matches(r, tool, { ...args, cmd: p })))) return { action: "allow", rule: this.cfg.allow.find((r) => this.matches(r, tool, { ...args, cmd: parts[0] })) };
      return { action: "none" };
    }
    const allow = this.cfg.allow.find((r) => this.matches(r, tool, args)); return allow ? { action: "allow", rule: allow } : { action: "none" };
  }
}

/** Fingerprint of the project files that can remove prompts or run commands (hooks and permission rules): approve once, re-approve when they change. */
export function projectConfigFingerprint(cwd: string): string | undefined {
  const files = [join(cwd, ".amness", "hooks.json"), Permissions.projectFile(cwd)].filter(existsSync);
  if (!files.length) return undefined;
  const h = createHash("sha256"); for (const f of files) h.update(f).update(readFileSync(f)); return h.digest("hex").slice(0, 16);
}

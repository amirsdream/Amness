// Where MCP servers come from, highest first (Claude Code's order):
//   local    .amness/settings.local.json  "mcpServers"   yours, this project only (git-excluded; ignored if git tracks it)
//   project  .mcp.json                     "mcpServers"   shared with the team in the repository; used only after you trust it (with hooks and permissions)
//   user     ~/.amness/config.json         "mcpServers"   yours, every project
// Plus servers from the command line (--mcp-config) or the editor (ACP session/new), which win over all three.
// The same name in two places: the higher one is used as a whole (no field-by-field merge).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalResource, mcpConfigProblem, oauthToken, type McpEntry, type McpHubOptions, type McpPinStore, type McpScope, type McpServerConfig, type OAuthStore, type OAuthTokens } from "../src/index.ts";
import { backend, deleteSecret, getSecret, setSecret } from "./keystore.ts";
import { home, projectFile, readJson, tracked, writeProjectFile } from "./config.ts";
import { loadState, saveState } from "./state.ts";

export type FileScope = "local" | "project" | "user";
export const SCOPE_TEXT: Record<McpScope, string> = { local: "only you, this project", project: "shared with the project", user: "all your projects", cli: "command line", editor: "the editor", session: "this session" };

export const mcpFile = (scope: FileScope, cwd: string) => scope === "user" ? join(home(), "config.json") : scope === "project" ? join(cwd, ".mcp.json") : projectFile(cwd, "project");

/** Credentials of the model providers: a project file must not be able to send them to a server it names (they read as empty in a remote url or header). */
const SECRET = /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENROUTER_API_KEY|TAVILY_API_KEY|AMNESS_.*(KEY|TOKEN)|AWS_.*|NPM_TOKEN|HTTPS?_PROXY)$/;

/** `${VAR}` and `${VAR:-default}`. An unset variable without a default stays as written and is reported. */
export function expandVars(s: string, env: NodeJS.ProcessEnv, o: { remote?: boolean; missing?: Set<string> } = {}): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name: string, def: string | undefined) => {
    if (o.remote && SECRET.test(name)) return def ?? "";
    const v = env[name]; if (v !== undefined) return v;
    if (def !== undefined) return def;
    o.missing?.add(name); return all;
  });
}
export function expandServer(c: McpServerConfig, env: NodeJS.ProcessEnv = process.env, missing = new Set<string>()): McpServerConfig {
  const x = (s: string, remote = false) => expandVars(s, env, { remote, missing });
  const map = (m: Record<string, string> | undefined, remote = false) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(String(v), remote)])) : undefined);
  return { ...c, command: c.command && x(c.command), args: c.args?.map((a) => x(String(a))), env: map(c.env), url: c.url && x(c.url, true), headers: map(c.headers, true), cwd: c.cwd && x(c.cwd) };
}

/** The mcpServers object of one file, as written. */
export function readServers(file: string): Record<string, McpServerConfig> {
  const j = readJson(file), m = j?.mcpServers;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, McpServerConfig>) : {};
}

/** Accept a Claude-Desktop/Claude-Code style file (`{ "mcpServers": {…} }`) or a bare map. */
export function parseMcpJson(text: string): Record<string, McpServerConfig> {
  const j = JSON.parse(text);
  const m = j && typeof j === "object" && j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : j;
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("expected { \"mcpServers\": { … } }");
  return m;
}

export type McpLoad = { entries: McpEntry[]; notes: string[] };
/**
 * Every configured server for this folder. Project (.mcp.json) servers are `pending` until the project's files are trusted;
 * servers you switched off for this project (`/mcp disable`, state.json) are `disabled`.
 */
export function mcpEntries(cwd: string, o: { trusted: boolean; extra?: McpEntry[]; strict?: boolean; env?: NodeJS.ProcessEnv } = { trusted: false }): McpLoad {
  const notes: string[] = [], seen = new Map<string, McpEntry>();
  const off = new Set(loadState().mcpDisabled?.[cwd] ?? []);
  const add = (name: string, raw: McpServerConfig, scope: McpScope, file?: string) => {
    if (seen.has(name)) return;
    const missing = new Set<string>(), config = expandServer(raw, o.env ?? process.env, missing), bad = mcpConfigProblem(config);
    if (bad) { notes.push(`MCP server "${name}"${file ? ` in ${file}` : ""} skipped: ${bad}`); return; }
    if (missing.size) notes.push(`MCP server "${name}": ${[...missing].map((m) => "${" + m + "}").join(", ")} not set`);
    seen.set(name, { name, config, scope, file, disabled: raw.disabled === true || off.has(name), pending: scope === "project" && !o.trusted });
  };
  for (const e of o.extra ?? []) add(e.name, e.config, e.scope, e.file);
  if (!o.strict) {
    const local = mcpFile("local", cwd);
    if (existsSync(local) && Object.keys(readServers(local)).length && tracked(cwd, local)) notes.push(".amness/settings.local.json is ignored: git tracks it");
    else for (const [n, c] of Object.entries(readServers(local))) add(n, c, "local", ".amness/settings.local.json");
    for (const [n, c] of Object.entries(readServers(mcpFile("project", cwd)))) add(n, c, "project", ".mcp.json");
    for (const [n, c] of Object.entries(readServers(mcpFile("user", cwd)))) add(n, c, "user", "~/.amness/config.json");
  }
  return { entries: [...seen.values()], notes };
}

/** Save a server in one place. Project (.mcp.json) keeps any other keys in the file; local goes through the git-excluded settings file. */
export function addServer(scope: FileScope, cwd: string, name: string, cfg: McpServerConfig) {
  if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`a server name may use letters, digits, ".", "-" and "_" (got "${name}")`);
  const bad = mcpConfigProblem(expandServer(cfg, new Proxy({}, { get: () => "x" }) as NodeJS.ProcessEnv)); if (bad) throw new Error(bad);   // ${VAR}s are filled in when the server starts
  const file = mcpFile(scope, cwd), j = readJson(file) ?? {};
  j.mcpServers = { ...(j.mcpServers as object), [name]: cfg };
  if (scope === "local") writeProjectFile(cwd, "project", j);
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(j, null, 2) + "\n"); }
  return file;
}
/** Remove a server; without a scope, from the first place that has it. Returns the scope it was removed from. */
export function removeServer(cwd: string, name: string, scope?: FileScope): FileScope | undefined {
  for (const s of scope ? [scope] : (["local", "project", "user"] as FileScope[])) {
    const file = mcpFile(s, cwd), j = readJson(file); const m = j?.mcpServers as Record<string, unknown> | undefined;
    if (!m || !(name in m)) continue;
    delete m[name]; if (!Object.keys(m).length) delete j!.mcpServers;
    if (s === "local") writeProjectFile(cwd, "project", j!); else writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    return s;
  }
  return undefined;
}
/** Switch a server off (or on again) for this project only. */
export function setDisabled(cwd: string, name: string, off: boolean) {
  const st = loadState(), cur = new Set(st.mcpDisabled?.[cwd] ?? []);
  if (off) cur.add(name); else cur.delete(name);
  st.mcpDisabled = { ...st.mcpDisabled, [cwd]: [...cur] }; if (!cur.size) delete st.mcpDisabled[cwd];
  saveState(st);
}

/** Servers from `--mcp-config <file or JSON>` (repeatable). */
export function cliEntries(values: string[], cwd: string): McpEntry[] {
  return values.flatMap((v) => {
    const text = v.trim().startsWith("{") ? v : readFileSync(join(cwd, v), "utf8");
    return Object.entries(parseMcpJson(text)).map(([name, config]) => ({ name, config, scope: "cli" as const, file: v.trim().startsWith("{") ? "--mcp-config" : v }));
  });
}

/** ACP's mcpServers (session/new): stdio `{name, command, args, env: [{name, value}]}`, http/sse `{type, name, url, headers: [{name, value}]}`. */
export function acpEntries(list: unknown): McpEntry[] {
  if (!Array.isArray(list)) return [];
  const kv = (a: unknown) => Array.isArray(a) ? Object.fromEntries(a.filter((x) => x && typeof x.name === "string").map((x) => [x.name, String(x.value ?? "")])) : undefined;
  return list.flatMap((s: any): McpEntry[] => {
    if (!s || typeof s.name !== "string") return [];
    const config: McpServerConfig = s.type === "http" || s.type === "sse" ? { type: s.type, url: s.url, headers: kv(s.headers) } : { command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: kv(s.env) };
    return [{ name: String(s.name).replace(/[^\w.-]+/g, "_"), config, scope: "editor" }];
  });
}

/** Approved tool descriptions live in ~/.amness/state.json: your servers by name and target, the others per project. */
export const pinStore = (): McpPinStore => ({
  get: (k) => loadState().mcpPins?.[k],
  set: (k, v) => { const st = loadState(); st.mcpPins = { ...st.mcpPins, [k]: v }; saveState(st); },
});
export const pinKeyFor = (cwd: string) => (e: McpEntry) => `${e.scope === "user" ? "user" : `${cwd}|${e.scope}`}|${e.name}|${e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" ")}`;
/**
 * MCP sign-in tokens: the system keychain when there is one (macOS Keychain, Windows DPAPI, Linux secret-tool), else ~/.amness/mcp-auth.json
 * (owner-only), and only in memory in a container (where keys must not be written). Keyed by the server's canonical address.
 */
const memTokens = new Map<string, OAuthTokens>();
const authFile = () => join(home(), "mcp-auth.json");
const readAuth = (): Record<string, OAuthTokens> => { try { return JSON.parse(readFileSync(authFile(), "utf8")); } catch { return {}; } };
export const oauthStore = (): OAuthStore => ({
  get: (k) => { if (backend() === "none") return memTokens.get(k); const s = getSecret(`mcp-oauth:${k}`); if (s) { try { return JSON.parse(s); } catch { /* fall through */ } } return readAuth()[k]; },
  set: (k, t) => {
    if (backend() === "none") return void memTokens.set(k, t);
    if (setSecret(`mcp-oauth:${k}`, JSON.stringify(t))) return;
    const all = readAuth(); all[k] = t; mkdirSync(home(), { recursive: true }); writeFileSync(authFile(), JSON.stringify(all, null, 2), { mode: 0o600 }); try { chmodSync(authFile(), 0o600); } catch { /* Windows */ }
  },
  delete: (k) => { memTokens.delete(k); deleteSecret(`mcp-oauth:${k}`); const all = readAuth(); if (k in all) { delete all[k]; writeFileSync(authFile(), JSON.stringify(all, null, 2), { mode: 0o600 }); } },
});
/** The hub options every front end uses: pins, cwd, and the sign-in token of each remote server. */
export const hubOptions = (cwd: string, more: McpHubOptions = {}): McpHubOptions => ({ cwd, pins: pinStore(), pinKey: pinKeyFor(cwd), tokenFor: (_n, c) => (c.url ? oauthToken(c.url, oauthStore()) : undefined), ...more });
export const signedIn = (url: string) => !!oauthStore().get(canonicalResource(url));

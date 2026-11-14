// `amness mcp …`: manage the MCP servers Amness connects to (the same files the TUI's /mcp and the desktop use).
import { resolve } from "node:path";
import { connectMcp, projectConfigFingerprint, type McpServerConfig } from "../src/index.ts";
import { addServer, mcpEntries, mcpFile, parseMcpJson, readServers, removeServer, setDisabled, SCOPE_TEXT, type FileScope } from "./mcpconfig.ts";
import { loadState } from "./state.ts";
import { bold, cyan, dim, green, red, yellow } from "./ui.ts";

export const MCP_HELP = `amness mcp <command>   MCP servers for Amness (terminal, desktop, amness run, editors)

  add [options] <name> <url>                  a remote server (Streamable HTTP; --transport sse for the old HTTP+SSE)
  add [options] <name> -- <command> [args…]   a local server started over stdio
      --scope local|project|user   local (default): this project, only you (.amness/settings.local.json, kept out of git)
                                   project: .mcp.json in the project, shared with your team (Claude Code's file)
                                   user: all your projects (~/.amness/config.json)
      --transport stdio|http|sse   -e, --env KEY=value (stdio)   -H, --header "Name: value" (http)
      --headers-helper <command>   prints a JSON object of headers (for tokens from a vault)
      --timeout <ms>               per-call limit (default 10 minutes)
  add-json [--scope …] <name> '<json>'        one entry in .mcp.json's format
  list                                         every server, where it comes from, and whether it connects
  get <name>                                   one server's settings and tools
  remove [--scope …] <name>
  enable <name> · disable <name>               switch one off or on for this project only

Values may use \${VAR} and \${VAR:-default}. Servers from .mcp.json start only after you trust the project
(the terminal asks; /trust asks again). In amness run they need --trust-project or --mcp-config.`;

const scopeOf = (v: string | undefined): FileScope => { if (v === undefined) return "local"; if (v === "local" || v === "project" || v === "user") return v; throw new Error(`--scope is local, project or user (got "${v}")`); };

export async function runMcpCli(argv: string[], o: { cwd?: string } = {}): Promise<number> {
  const cwd = resolve(o.cwd ?? process.cwd()), [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(MCP_HELP); return cmd ? 0 : 1; }
  const trusted = () => { const fp = projectConfigFingerprint(cwd); return !!fp && loadState().hookTrust?.[cwd] === fp; };
  try {
    if (cmd === "add" || cmd === "add-json") {
      const dash = rest.indexOf("--"), opts = dash >= 0 ? rest.slice(0, dash) : rest, after = dash >= 0 ? rest.slice(dash + 1) : [];
      let scope: string | undefined, transport: string | undefined, helper: string | undefined, timeout: number | undefined; const env: Record<string, string> = {}, headers: Record<string, string> = {}, pos: string[] = [];
      for (let i = 0; i < opts.length; i++) {
        const a = opts[i], val = () => { const v = a.includes("=") && a.startsWith("--") ? a.slice(a.indexOf("=") + 1) : opts[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
        const flag = a.startsWith("--") ? a.split("=")[0] : a;
        if (flag === "--scope" || flag === "-s") scope = val();
        else if (flag === "--transport" || flag === "-t") transport = val();
        else if (flag === "--env" || flag === "-e") { const kv = val(), k = kv.indexOf("="); if (k < 1) throw new Error(`--env takes KEY=value (got "${kv}")`); env[kv.slice(0, k)] = kv.slice(k + 1); }
        else if (flag === "--header" || flag === "-H") { const hv = val(), k = hv.indexOf(":"); if (k < 1) throw new Error(`--header takes "Name: value" (got "${hv}")`); headers[hv.slice(0, k).trim()] = hv.slice(k + 1).trim(); }
        else if (flag === "--headers-helper") helper = val();
        else if (flag === "--timeout") timeout = Number(val());
        else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        else pos.push(a);
      }
      const sc = scopeOf(scope), name = pos[0]; if (!name) throw new Error("give the server a name");
      let cfg: McpServerConfig;
      if (cmd === "add-json") { if (!pos[1]) throw new Error("add-json needs the JSON"); const j = JSON.parse(pos[1]); cfg = j.mcpServers ? Object.values(parseMcpJson(pos[1]))[0] : j; }
      else if (after.length) cfg = { ...(transport && transport !== "stdio" ? { type: transport as McpServerConfig["type"] } : {}), command: after[0], args: after.slice(1), ...(Object.keys(env).length && { env }) };
      else if (pos[1] && /^https?:\/\//.test(pos[1])) cfg = { type: transport === "sse" ? "sse" : "http", url: pos[1], ...(Object.keys(headers).length && { headers }), ...(helper && { headersHelper: helper }) };
      else if (pos[1]) cfg = { command: pos[1], args: pos.slice(2), ...(Object.keys(env).length && { env }) };
      else throw new Error("give a url, or -- and the command that starts the server");
      if (timeout) cfg.timeout = timeout;
      const file = addServer(sc, cwd, name, cfg);
      console.log(`${green("✓")} ${bold(name)} saved in ${file} ${dim(`(${SCOPE_TEXT[sc]})`)}`);
      if (sc === "project") console.log(dim("  shared with everyone who clones the project; each person approves it once (the terminal asks)"));
      return 0;
    }
    if (cmd === "remove") {
      const si = rest.findIndex((a) => a === "--scope" || a === "-s"); const sc = si >= 0 ? scopeOf(rest[si + 1]) : undefined; const name = rest.filter((_, i) => si < 0 || (i !== si && i !== si + 1))[0];
      if (!name) throw new Error("which server?");
      const from = removeServer(cwd, name, sc); if (!from) { console.error(`no server "${name}"${sc ? ` in ${mcpFile(sc, cwd)}` : ""}`); return 1; }
      console.log(`${green("✓")} removed ${bold(name)} ${dim(`(${SCOPE_TEXT[from]})`)}`); return 0;
    }
    if (cmd === "enable" || cmd === "disable") { if (!rest[0]) throw new Error("which server?"); setDisabled(cwd, rest[0], cmd === "disable"); console.log(`${rest[0]} ${cmd === "disable" ? "switched off" : "switched on"} for ${cwd}`); return 0; }
    if (cmd === "list" || cmd === "get") {
      const { entries, notes } = mcpEntries(cwd, { trusted: trusted() });
      const pick = cmd === "get" ? entries.filter((e) => e.name === rest[0]) : entries;
      if (cmd === "get" && !pick.length) { console.error(`no server "${rest[0]}" (amness mcp list)`); return 1; }
      if (!entries.length) console.log(dim(`no MCP servers. Add one: amness mcp add <name> <url>  or  amness mcp add <name> -- <command>`));
      for (const n of notes) console.log(`${yellow("!")} ${n}`);
      await Promise.all(pick.map(async (e) => {
        const where = `${SCOPE_TEXT[e.scope]}${e.file ? `, ${e.file}` : ""}`, target = e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" ");
        if (e.disabled) return void console.log(`${dim("○")} ${bold(e.name)}  ${dim(`switched off · ${where}`)}\n    ${dim(target)}`);
        if (e.pending) return void console.log(`${yellow("⏸")} ${bold(e.name)}  ${dim(`waits for your trust · ${where}`)}\n    ${dim(target)}`);
        try {
          const h = await connectMcp(e.config, { name: e.name, prefix: e.name, cwd, probeMs: 8000, timeoutMs: 20_000 });
          console.log(`${green("●")} ${bold(e.name)}  ${dim(`${h.transport} ${h.era} · ${h.tools.length} tools · ${where}`)}\n    ${dim(target)}`);
          if (cmd === "get") { if (h.server.name) console.log(dim(`    server: ${h.server.name} ${h.server.version ?? ""}`)); for (const t of h.tools) console.log(`    ${cyan(t.name)} ${t.risky ? yellow("asks first") : dim("read-only")}  ${dim(t.description.split("\n")[0].slice(0, 90))}`); }
          h.close();
        } catch (err) { console.log(`${red("✗")} ${bold(e.name)}  ${dim(where)}\n    ${dim(target)}\n    ${red((err as Error).message.slice(0, 300))}`); }
      }));
      if (cmd === "get") { const raw = readServers(mcpFile(pick[0].scope as FileScope, cwd))[pick[0].name]; if (raw) console.log(dim(JSON.stringify(raw, null, 2).replace(/^/gm, "    "))); }
      return 0;
    }
    console.error(`unknown command "mcp ${cmd}"\n\n${MCP_HELP}`); return 2;
  } catch (e) { console.error(`${red("✗")} ${(e as Error).message}`); return 2; }
}

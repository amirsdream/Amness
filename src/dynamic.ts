import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineTool, type Registry, type Tool } from "./harness.ts";
import { runShell } from "./code.ts";

// ------------------------------------------------------------ agent-defined shell tools
type Param = { type: "string" | "integer" | "number" | "boolean"; description?: string };
export type ToolDef = { name: string; description: string; command: string; params: Record<string, Param> };

const quote = (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** Turn a saved definition into a real tool. `{{param}}` placeholders are shell-quoted, so arguments can't inject commands. */
export function shellTool(d: ToolDef, cwd: string): Tool {
  return defineTool<Record<string, unknown>>({
    name: d.name, description: `${d.description} (agent-defined; runs: ${d.command})`,
    schema: { type: "object", required: Object.keys(d.params), additionalProperties: false, properties: d.params },
    run: (a) => runShell(d.command.replace(/\{\{(\w+)\}\}/g, (_, k) => quote(a[k])), cwd, 60_000),
  });
}

/**
 * Lets the agent grow its own toolbox: `create_tool` registers a shell-command tool for the rest of the run.
 * Creation is `risky` (a human sees the exact command). Definitions persist to `file` and reload with `loadSavedTools`.
 */
export function createToolTool(o: { cwd: string; file?: string; max?: number }): Tool<ToolDef> {
  const made = new Set<string>();
  return defineTool<ToolDef>({
    name: "create_tool",
    description: "Define a new reusable tool backed by a shell command, e.g. a project-specific test or lint runner. Use {{param}} placeholders for inputs. Only create a tool when you will call it repeatedly.",
    schema: { type: "object", required: ["name", "description", "command"], properties: {
      name: { type: "string", description: "snake_case, e.g. run_unit_tests" }, description: { type: "string" },
      command: { type: "string", description: "shell command, with {{param}} placeholders" },
      params: { type: "object", description: "map of param name -> {type: string|integer|number|boolean, description}" } } },
    risky: (d) => `creates a new tool that will run: ${d?.command}`,
    run: (d, { registry }) => {
      d.params ??= {};
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(d.name)) return "ERROR: name must be snake_case, 2-41 chars";
      if (registry.get(d.name) && !made.has(d.name)) return `ERROR: ${d.name} already exists and is not agent-defined`;
      if (made.size >= (o.max ?? 20) && !made.has(d.name)) return "ERROR: too many agent-defined tools";
      for (const [k, p] of Object.entries(d.params))
        if (!/^\w+$/.test(k) || !["string", "integer", "number", "boolean"].includes(p?.type)) return `ERROR: bad param ${k}; type must be string|integer|number|boolean`;
      const used = [...d.command.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      const bad = used.filter((k) => !(k in d.params));
      if (bad.length) return `ERROR: command uses undeclared param(s): ${bad.join(", ")}`;
      registry.add(shellTool(d, o.cwd)); made.add(d.name);
      if (o.file) {
        const all: ToolDef[] = existsSync(o.file) ? JSON.parse(readFileSync(o.file, "utf8")) : [];
        writeFileSync(o.file, JSON.stringify([...all.filter((x) => x.name !== d.name), d], null, 2));
      }
      return `tool ${d.name} created; you can call it from your next turn.`;
    },
  });
}

export function loadSavedTools(file: string, cwd: string): Tool[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ToolDef[]).map((d) => shellTool(d, cwd)) : [];
}

// ------------------------------------------------------------ MCP (stdio JSON-RPC)
export type McpHandle = { tools: Tool[]; close: () => void };

/**
 * Connect to an MCP server over stdio and expose its tools. Names become `<prefix>__<tool>`.
 * Tools the server marks destructive (or not read-only) need approval; override with `risky`.
 * With more than `deferAbove` tools they are deferred behind `tool_search` so the prompt stays small.
 */
export async function loadMcp(command: string, args: string[] = [], o: { prefix?: string; env?: Record<string, string>; risky?: (t: any) => boolean; deferAbove?: number; timeoutMs?: number } = {}): Promise<McpHandle> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...o.env } });
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let id = 0, buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } } catch { /* not JSON-RPC; ignore */ }
    }
  });
  const dead = (why: string) => { for (const p of pending.values()) p.fail(new Error(why)); pending.clear(); };
  child.on("exit", (c) => dead(`MCP server exited (${c})`)); child.on("error", (e) => dead(`MCP server failed: ${e.message}`));
  const rpc = (method: string, params?: unknown) => new Promise<any>((ok, fail) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); fail(new Error(`MCP ${method} timed out`)); }, o.timeoutMs ?? 30_000);
    pending.set(n, { ok: (v) => (clearTimeout(timer), ok(v)), fail: (e) => (clearTimeout(timer), fail(e)) });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "amness", version: "0.1.0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed: any[] = [];
    for (let cursor: string | undefined; ; ) {
      const r = await rpc("tools/list", cursor ? { cursor } : {});
      listed.push(...r.tools); cursor = r.nextCursor; if (!cursor) break;
    }
    const prefix = o.prefix ?? command.split("/").pop()!.replace(/\W+/g, "_");
    const tools = listed.map((t): Tool => {
      const a = t.annotations ?? {};
      const risky = o.risky ? o.risky(t) : a.destructiveHint === true || (t.annotations && a.readOnlyHint !== true && a.destructiveHint !== false);
      return {
        name: `${prefix}__${t.name}`.replace(/[^\w-]/g, "_").slice(0, 64), description: t.description ?? t.title ?? t.name,
        schema: t.inputSchema ?? { type: "object" }, risky: risky ? () => `MCP tool ${t.name} may change external state` : false,
        deferred: listed.length > (o.deferAbove ?? 15), untrusted: true,
        run: async (args) => {
          const r = await rpc("tools/call", { name: t.name, arguments: args });
          const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
          if (r.isError) throw new Error(text || "tool error");
          return text || JSON.stringify(r.structuredContent ?? "ok");
        },
      };
    });
    return { tools, close: () => child.kill() };
  } catch (e) { child.kill(); throw e; }
}

/** Convenience: add MCP tools to a registry; returns the close function. */
export async function mountMcp(reg: Registry, command: string, args?: string[], o?: Parameters<typeof loadMcp>[2]) {
  const h = await loadMcp(command, args, o); reg.add(...h.tools); return h.close;
}

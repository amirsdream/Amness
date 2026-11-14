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

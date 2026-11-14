// `amness acp`: serve the Agent Client Protocol on stdin/stdout so an editor can host Amness. stdout carries only protocol messages; everything else goes to stderr.
import { Budget, createCodeAgent, McpHub, projectConfigFingerprint, serveAcp, type Model } from "../src/index.ts";
import { acpEntries, mcpEntries } from "./mcpconfig.ts";
import { loadState } from "./state.ts";

export const ACP_HELP = `usage: amness acp
  Speak the Agent Client Protocol (JSON-RPC lines) on stdin/stdout, for editors such as Zed or JetBrains.
  Uses your configured provider and model. Risky actions are sent to the editor as permission requests.
  Example Zed setting:  "agent_servers": { "Amness": { "command": "amness", "args": ["acp"] } }`;

export async function runAcp(deps: { model: () => Model; version: string; maxTokens: number }): Promise<number> {
  const model = deps.model();
  await serveAcp({
    input: process.stdin, output: process.stdout, version: deps.version,
    makeAgent: async ({ cwd, onEvent, approve, signal, mcpServers }) => {
      const agent = createCodeAgent({ model, cwd, chat: true, approve, onEvent, signal, budget: new Budget({ maxTokens: deps.maxTokens, maxMs: 60 * 60_000 }), permissions: { mode: () => "default" } });
      // The editor's servers, then yours (.amness/settings.local.json, ~/.amness/config.json), then .mcp.json if you trusted this project in the terminal.
      const fp = projectConfigFingerprint(cwd), trusted = !!fp && loadState().hookTrust?.[cwd] === fp;
      const { entries, notes } = mcpEntries(cwd, { trusted, extra: acpEntries(mcpServers) });
      for (const n of notes) process.stderr.write(`amness acp: ${n}\n`);
      const hub = new McpHub({ cwd, warn: (m) => process.stderr.write(`amness acp: MCP ${m}\n`) });
      await hub.start(entries);
      for (const r of hub.rows()) if (r.error) process.stderr.write(`amness acp: MCP ${r.name}: ${r.error}\n`);
      agent.registry.add(...hub.tools());
      return { chat: agent.chat.bind(agent), close: () => hub.close() };
    },
  });
  return 0;
}

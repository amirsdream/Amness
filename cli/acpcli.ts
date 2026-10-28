// `amness acp`: serve the Agent Client Protocol on stdin/stdout so an editor can host Amness. stdout carries only protocol messages; everything else goes to stderr.
import { Budget, createCodeAgent, serveAcp, type Model } from "../src/index.ts";

export const ACP_HELP = `usage: amness acp
  Speak the Agent Client Protocol (JSON-RPC lines) on stdin/stdout, for editors such as Zed or JetBrains.
  Uses your configured provider and model. Risky actions are sent to the editor as permission requests.
  Example Zed setting:  "agent_servers": { "Amness": { "command": "amness", "args": ["acp"] } }`;

export async function runAcp(deps: { model: () => Model; version: string; maxTokens: number }): Promise<number> {
  const model = deps.model();
  await serveAcp({
    input: process.stdin, output: process.stdout, version: deps.version,
    makeAgent: ({ cwd, onEvent, approve, signal }) => createCodeAgent({ model, cwd, chat: true, approve, onEvent, signal, budget: new Budget({ maxTokens: deps.maxTokens, maxMs: 60 * 60_000 }), permissions: { mode: () => "default" } }),
  });
  return 0;
}

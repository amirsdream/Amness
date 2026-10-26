// OPENAI_API_KEY=... node examples/code.ts <repo-dir> "task" [--verify "npm test"] [--resume] [--max-tokens 300000]
//                    [--self-extend] [--mcp "npx -y @modelcontextprotocol/server-github"]
import { createInterface } from "node:readline/promises";
import { Budget, createCodeAgent, loadMcp, openai } from "../src/index.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const verify = flag("--verify"), maxTokens = Number(flag("--max-tokens") ?? 300_000);
const mcpCmd = flag("--mcp");
const selfExtend = args.includes("--self-extend") && !!args.splice(args.indexOf("--self-extend"), 1);
const resume = args.includes("--resume") && !!args.splice(args.indexOf("--resume"), 1);
const [cwd, ...task] = args;
if (!cwd || !task.length) { console.error('usage: node examples/code.ts <repo-dir> "task" [--verify cmd] [--resume] [--max-tokens n]'); process.exit(1); }

const rl = createInterface({ input: process.stdin, output: process.stderr });
const budget = new Budget({ maxTokens, maxMs: 30 * 60_000 });
const mcp = mcpCmd ? await loadMcp(mcpCmd.split(" ")[0], mcpCmd.split(" ").slice(1)) : undefined;
const agent = createCodeAgent({
  model: openai(), cwd, verify, budget, selfExtend, tools: mcp?.tools,
  checkpointFile: `${cwd}/.amness/checkpoint.json`,
  // Risky shell commands pause here. Answer y, n, or type a note to steer the agent.
  approve: async ({ name, args, reason }) => {
    const a = (await rl.question(`\n⚠ ${name} wants approval (${reason}):\n  ${JSON.stringify(args)}\n  [y/n/note] > `)).trim();
    return a === "y" ? true : a === "n" || !a ? false : a;
  },
  onEvent: (e) => e.kind === "tool" ? console.error(`· ${e.name} ${e.args.slice(0, 100)}`) : e.kind === "edit" ? console.error(`✎ ${e.path} +${e.added} -${e.removed}`) : "detail" in e ? console.error(`[${e.kind}] ${e.detail.slice(0, 120)}`) : e.kind === "finish" ? console.error(`[finish] ${e.summary}`) : undefined,
});
const r = await agent.run(task.join(" "), { resume });
rl.close(); mcp?.close();
console.log(`\n${r.finished ? "✔" : "✘"} ${r.text}\n(${r.steps} steps, ${budget.tokens} tokens)`);

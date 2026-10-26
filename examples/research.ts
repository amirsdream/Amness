// OPENAI_API_KEY=... [TAVILY_API_KEY=...] node examples/research.ts "your question"
import { createDeepAgent, openai } from "../src/index.ts";

const goal = process.argv.slice(2).join(" ");
if (!goal) { console.error('usage: node examples/research.ts "question"'); process.exit(1); }

const agent = createDeepAgent({
  model: openai({ model: process.env.AMNESS_MODEL ?? "gpt-4.1" }),
  dir: ".amness",   // files (incl. /report.md and /memory/*) persist between runs
  onEvent: (e) => {
    const who = (e.agent ?? "lead").padEnd(8);
    if (e.kind === "tool") console.error(`${who} ${e.name} ${e.args.slice(0, 90)}`);
    else if ("detail" in e) console.error(`${who} [${e.kind}] ${e.detail.slice(0, 90)}`);
  },
});
const r = await agent.run(goal);
console.log(r.report ?? r.text);

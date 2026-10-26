// OPENAI_API_KEY=... node examples/eval.ts [trials]   -> pass-rate / steps / tokens table, baseline vs full harness
import { codeVariants, evaluate, openai } from "../src/index.ts";
import { cases } from "./cases.ts";

const trials = Number(process.argv[2] ?? 3);
const { table } = await evaluate(cases, codeVariants(openai()), {
  trials, onRow: (r) => console.error(`${r.case.padEnd(22)} ${r.variant.padEnd(14)} ${r.pass ? "PASS" : "FAIL"} ${r.steps} steps ${r.tokens} tok ${r.note ?? ""}`),
});
console.log("\n" + table);

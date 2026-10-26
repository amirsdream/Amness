// Guided demo: a scripted "model" that makes realistic mistakes so every harness guard fires, with no API key.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, type Approve, type Event, type Message, type Model } from "../src/index.ts";

let id = 0;
const call = (name: string, args: unknown, note?: string): Message => ({
  role: "assistant", content: note ?? null, usage: { total_tokens: 420 },
  tool_calls: [{ id: `demo${++id}`, function: { name, arguments: JSON.stringify(args) } }],
});

export const DEMO_TASK = "sumTo(n) should return 1+2+...+n but the tests fail. Fix it.";

export async function runDemo(o: { approve: Approve; onEvent: (e: Event) => void; delayMs?: number; model?: (m: Model) => Model }) {
  const dir = mkdtempSync(join(tmpdir(), "amness-demo-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sum.js"), "exports.sumTo = (n) => { let s = 0; for (let i = 1; i < n; i++) s += i; return s; };\n");
  writeFileSync(join(dir, "test.js"), "const a = require('assert'); const { sumTo } = require('./sum'); a.equal(sumTo(3), 6); a.equal(sumTo(1), 1); console.log('tests passed');\n");

  const script: Message[] = [
    { role: "assistant", content: "I'll start by looking at the code and the failing test.", usage: { total_tokens: 300 } }, // intent, no action → nudge
    call("read_file", {}),                                                                            // missing arg → repair
    call("edit_file", { path: "sum.js", old: "i < n", new: "i <= n" }),                                // edit before read → blocked
    call("list_files", {}),
    call("read_file", { path: "sum.js" }),
    call("sh", { cmd: "rm -rf node_modules && git clean -fdx" }),                                      // dangerous → approval prompt
    call("finish", { summary: "Looks fine to me." }),                                                  // lies → verify gate runs tests → rejected
    call("edit_file", { path: "sum.js", old: "i < n", new: "i <= n" }),
    call("sh", { cmd: "node test.js" }),
    call("finish", { summary: "Fixed off-by-one in sumTo (i < n → i <= n); test.js passes." }),
  ];
  const scripted: Model = async () => { await new Promise((r) => setTimeout(r, o.delayMs ?? 500)); return script.shift()!; };
  const events: Event[] = [];
  const agent = createCodeAgent({
    model: o.model ? o.model(scripted) : scripted, cwd: dir, verify: "node test.js", approve: o.approve,
    onEvent: (e) => (events.push(e), o.onEvent(e)),
  });
  const result = await agent.run(DEMO_TASK);
  return { dir, result, events };
}

export const explain: Record<string, string> = {
  nudge: "model said what it would do but did nothing → pushed back to act",
  repair: "malformed tool call → exact error returned, model self-corrected",
  denied: "dangerous command → human approval required",
  rejected: "model claimed success → real test run disagreed, finish blocked",
  tool: "tool calls executed",
};

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/index.ts";
import { contextMap, tokenReport } from "../cli/tui/tokens.ts";
import { cellWidth, strip } from "../cli/tui/text.ts";

const msgs = (toolChars: number): Message[] => [
  { role: "system", content: "s".repeat(360) }, { role: "user", content: "u".repeat(180) },
  { role: "assistant", content: "a".repeat(90), tool_calls: [{ id: "1", function: { name: "read_file", arguments: '{"path":"big.ts"}' } }] },
  { role: "tool", tool_call_id: "1", content: "t".repeat(toolChars) },
];

test("contextMap attributes size to system/you/assistant/tool output and names the biggest tool result", () => {
  const m = contextMap(msgs(3600));
  const by = Object.fromEntries(m.parts.map((p) => [p.key, p.tokens]));
  assert.ok(by.tools > by.system && by.system > by.you && by.you > by.assistant - 10);
  assert.equal(by.defs, 0);
  assert.equal(contextMap(msgs(3600), 0, 7200).parts.find((p) => p.key === "defs")!.tokens, 2000);                // tool definitions are attributed too
  assert.deepEqual(m.biggest, { name: "read_file", tokens: 1000 });
  assert.equal(m.total, m.parts.reduce((n, p) => n + p.tokens, 0));
});

test("contextMap scales estimates to the real prompt size when the API reported one", () => {
  const m = contextMap(msgs(3600), 10_000);
  assert.ok(Math.abs(m.total - 10_000) <= 4); assert.ok(m.biggest!.tokens > 5000);
  assert.deepEqual(contextMap([]).parts.map((p) => p.tokens), [0, 0, 0, 0, 0]);
});

test("tokenReport: gauge, stacked map with legend, sparkline, usage, cost, advice that depends on how full the window is", () => {
  const base = { model: "claude-opus-5-5", messages: msgs(36_000), usage: { prompt: 500_000, completion: 20_000, calls: 10 }, series: [10_000, 30_000, 60_000, 120_000], turnTokens: 80_000, turnBudget: 300_000, width: 100 };
  const lo = tokenReport({ ...base, lastPrompt: 30_000 }).map(strip);
  const txt = lo.join("\n");
  assert.match(txt, /context window\s+▰{1,}▱+ 3%\s+30k of 1\.0M/); assert.match(txt, /tool output \d+%/); assert.match(txt, /■ system \d+%/);
  assert.match(txt, /one read_file result is ~\d+k tokens/); assert.match(txt, /prompt size\/req\s+[▁-█]{4}\s+4 requests, latest 120k/);
  assert.match(txt, /500k in · 20k out · 10 requests \(avg 50k in\)/); assert.match(txt, /est\. cost\s+\$2\.40\s+at \$4\/\$20 per M tokens/);
  assert.match(txt, /turn budget\s+▰+▱+ 80k of 300k/); assert.match(txt, /mostly tool output/);
  assert.ok(lo.every((l) => cellWidth(l) <= 100));
  assert.match(tokenReport({ ...base, lastPrompt: 700_000 }).map(strip).join("\n"), /getting full: \/compact/);
  assert.match(tokenReport({ ...base, lastPrompt: 950_000 }).map(strip).join("\n"), /nearly full: run \/compact now/);
  const unknown = tokenReport({ ...base, model: "my-local-model", lastPrompt: 1000, messages: [] }).map(strip).join("\n");
  assert.match(unknown, /unknown for this model/);
});

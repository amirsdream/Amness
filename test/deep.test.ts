import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepAgent, defineTool, type Message, type Model } from "../src/index.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({
  role: "assistant", content: null,
  tool_calls: cs.map(([name, a]) => ({ id: `c${++n}`, function: { name, arguments: JSON.stringify(a) } })),
});
/** Routes by role: lead vs subagent (identified by the system prompt). */
const routed = (lead: Message[], sub: Message[]) => {
  const seen: { lead: Message[][]; sub: Message[][] } = { lead: [], sub: [] };
  const model: Model = async (msgs) => {
    const isSub = msgs[0].content!.startsWith("You are a focused");
    seen[isSub ? "sub" : "lead"].push(msgs.map((m) => ({ ...m })));
    return (isSub ? sub : lead).shift()!;
  };
  return { model, seen };
};
const toolOut = (msgs: Message[]) => msgs.filter((m) => m.role === "tool").map((m) => m.content!);
const todo = (s: string) => ({ todos: [{ task: "research", status: s }] });

test("plan -> parallel subagents -> report -> finish; gate rejects early finish", async () => {
  const { model, seen } = routed(
    [
      call(["finish", { summary: "too early" }]),                                   // no plan: rejected
      call(["write_todos", todo("in_progress")]),
      call(["task", { description: "find A" }], ["task", { description: "find B" }]), // parallel
      call(["write_todos", todo("done")]),
      call(["finish", { summary: "no report" }]),                                   // no report.md: rejected
      call(["write_file", { path: "report.md", content: "# A and B" }]),
      call(["finish", { summary: "done" }]),
    ],
    [call(["finish", { summary: "A is 1" }]), call(["finish", { summary: "B is 2" }])],
  );
  const a = createDeepAgent({ model, web: false });
  const r = await a.run("goal");
  assert.equal(r.finished, true); assert.equal(r.report, "# A and B");
  const t = toolOut(seen.lead.at(-1)!);
  assert.match(t[0], /no plan/); assert.deepEqual(t.slice(2, 4), ["A is 1", "B is 2"]); // order preserved
  assert.match(t[5], /\/report\.md first/);
  assert.equal(seen.sub.length, 2);
  assert.ok(!seen.sub[0][1].content!.includes("goal")); // subagent sees only its brief
});

test("subagents cannot spawn subagents", async () => {
  const { model, seen } = routed(
    [call(["write_todos", todo("done")]), call(["task", { description: "x" }]), call(["finish", { summary: "." }])],
    [call(["task", { description: "recurse" }]), call(["finish", { summary: "s" }])],
  );
  await createDeepAgent({ model, web: false, maxSteps: 3 }).run("g");
  assert.match(toolOut(seen.sub.at(-1)!)[0], /unknown tool "task"/);
});

test("big tool results are offloaded to files with a preview", async () => {
  const big = defineTool({ name: "big", description: "", schema: { type: "object" }, run: () => "z".repeat(20_000) });
  const { model, seen } = routed([call(["big", {}]), call(["read_file", { path: "/offload/1-big.txt", start: 1, end: 1 }]), call(["finish", { summary: "." }])], []);
  const a = createDeepAgent({ model, web: false, tools: [big], maxSteps: 3 });
  await a.run("g");
  const t = toolOut(seen.lead.at(-1)!);
  assert.match(t[0], /20000 chars total, saved to \/offload\/1-big\.txt/); assert.ok(t[0].length < 1500);
  assert.equal(a.fs.read("/offload/1-big.txt").length, 20_000);
});

test("vfs persists across runs and blocks path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-"));
  const { model } = routed([], []);
  const a = createDeepAgent({ model, web: false, dir });
  a.fs.write("/memory/facts.md", "hi"); a.fs.write("../../escape.txt", "x");
  const b = createDeepAgent({ model, web: false, dir });
  assert.equal(b.fs.read("/memory/facts.md"), "hi");
  assert.equal(b.fs.read("/escape.txt"), "x"); // normalised inside the sandbox, not outside
});

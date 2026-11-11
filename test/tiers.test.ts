import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, analyze, countEvents, formatReport, harnessCard, harnessVariant, parseRoleSpec, withCard, type Event, type Message, type Model, type Row } from "../src/index.ts";

let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: `t${++n}`, function: { name, arguments: JSON.stringify(args) } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });

test("parseRoleSpec: role=model pairs joined by +; unknown roles and bad pairs are refused", () => {
  assert.deepEqual(parseRoleSpec("explore=server:lab+review=anthropic:claude-haiku-5-5"), { explore: "server:lab", review: "anthropic:claude-haiku-5-5" });
  assert.deepEqual(parseRoleSpec("compact=server:lab/qwen-4b"), { compact: "server:lab/qwen-4b" });
  assert.throws(() => parseRoleSpec("writer=x"), /unknown role "writer"/);
  assert.throws(() => parseRoleSpec("explore"), /write role=model/);
});

test("a role variant builds each referenced model, runs the explorer on it, and splits the spending by tier", async () => {
  const asked: string[] = [];
  const lead = [call("task", { description: "find it" }), call("finish", { summary: "found" })];
  const main = withCard(async () => lead.shift()!, { id: "opus", tier: "frontier" });
  const modelFor = (ref: string): Model => (asked.push(ref), withCard(async () => call("finish", { summary: "it is in a.txt" }), { id: ref, tier: "local" }));
  const v = harnessVariant(main, "full@explore=server:lab", { modelFor });
  assert.equal(v.name, "full@explore=server:lab"); assert.deepEqual(asked, ["server:lab"]);
  const dir = mkdtempSync(join(tmpdir(), "amness-tier-"));
  const out = await v.run({ name: "c", task: "where is it", files: {}, check: "true" }, dir);
  assert.equal(out.text, "found");
  assert.deepEqual(Object.keys(out.byModel ?? {}).sort(), ["opus", "server:lab"]);
  assert.equal(out.byTier?.local.calls, 1); assert.equal(out.byTier?.frontier.calls, 2);
  const sum = Object.values(out.byModel!).reduce((k, e) => k + e.tokens, 0);
  assert.equal(sum, out.tokens, "the tiers add up to the total");
  assert.throws(() => harnessVariant(main, "full@explore=x"), /needs models by reference/);
});

test("Budget: per-model spending reaches the parent through slices; byTier sums models of one tier", () => {
  const b = new Budget(), s = b.slice(0.5), m = (t: number): Message => ({ role: "assistant", content: "x", usage: { prompt_tokens: t, completion_tokens: 0, total_tokens: t } });
  b.add(m(100), { id: "opus", tier: "frontier" }, 50); s.add(m(30), { id: "qwen", tier: "local" }, 400); s.add(m(20), { id: "gemma", tier: "local" }, 100);
  assert.deepEqual(Object.keys(b.byModel).sort(), ["gemma", "opus", "qwen"]);
  assert.deepEqual([b.byTier.local.tokens, b.byTier.local.ms, b.byTier.frontier.tokens], [50, 500, 100]);
  assert.equal(b.tokens, 150);
});

test("analyze and the report show a per-tier table only when runs mixed models", () => {
  const r = (variant: string, pass: boolean, tiers?: Row["byTier"]): Row => ({ case: "c" + (n++ % 3), variant, trial: 0, pass, steps: 3, tokens: 1000, ms: 100, byTier: tiers });
  const rows = [r("full", true), r("full", true), r("full", false), r("full@explore=server:lab", true, { local: { calls: 4, tokens: 800, prompt: 0, completion: 0, cached: 0, ms: 9000 }, frontier: { calls: 2, tokens: 200, prompt: 0, completion: 0, cached: 0, ms: 1000 } }),
    r("full@explore=server:lab", false, { local: { calls: 4, tokens: 800, prompt: 0, completion: 0, cached: 0, ms: 9000 }, frontier: { calls: 2, tokens: 200, prompt: 0, completion: 0, cached: 0, ms: 1000 } })];
  const a = analyze(rows, { baseline: "full" });
  assert.equal(a.stats.find((s) => s.variant === "full")!.tiers, undefined);
  const t = a.stats.find((s) => s.variant.includes("@"))!.tiers!;
  assert.equal(t.local.tokensPerSolved, 1600); assert.equal(t.local.secs, 9);
  assert.match(formatReport(a), /per tier/);
});

test("harness card: the seven layers, every role, guards reported by whether they are on", () => {
  const c = harnessCard({ version: "9.9.9", model: { provider: "anthropic", id: "claude-opus-5-5", tier: "frontier", window: 200000, profileSources: ["~/.amness/profile.json"] }, roles: { explore: "server:lab/qwen", compact: "anthropic:claude-haiku-5-5" }, off: ["nudge", "argfix"], verify: "npm test", sandbox: "workspace" });
  assert.deepEqual(Object.keys(c), ["version", "execution", "tools", "context", "scheduling", "observability", "verification", "governance"]);
  assert.deepEqual(c.execution.roles, { explore: "server:lab/qwen", compact: "anthropic:claude-haiku-5-5" });
  assert.equal(c.scheduling.nudge, false); assert.equal(c.scheduling.loopGuard, true); assert.equal(c.tools.argumentRepair, false);
  assert.equal(c.verification.verify, "npm test"); assert.equal(c.governance.sandbox, "workspace");
});

test("countEvents: a read of an already-read file counts as a reread only after the context was squeezed", () => {
  const ev: Record<string, number> = {}, on = countEvents(ev);
  const read = (p: string): Event => ({ kind: "tool", id: "x", name: "read_file", args: JSON.stringify({ path: p }), result: "..." });
  on(read("a.ts")); on(read("a.ts")); assert.equal(ev.reread, undefined);
  on({ kind: "trim", saved: 100, what: "tool output condensed" }); on(read("a.ts")); assert.equal(ev.reread, undefined);   // condensing new output is not a squeeze
  on({ kind: "rollover", detail: "note" }); on(read("a.ts")); on(read("b.ts")); assert.equal(ev.reread, 1);
});

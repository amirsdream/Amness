import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_SYSTEM, LOCAL_SYSTEM, createCodeAgent, harnessVariant, withCard, type Message, type Model, type ModelCard } from "../src/index.ts";

/** One task run; returns the system prompt and the tool names of the first request. */
async function firstRequest(card: ModelCard, o: Record<string, unknown> = {}) {
  let sys = "", tools: string[] = [];
  const raw: Model = async (m, specs) => { if (!sys) { sys = m[0].content ?? ""; tools = specs.map((s) => s.name); } return { role: "assistant", content: null, tool_calls: [{ id: "f", function: { name: "finish", arguments: '{"summary":"ok"}' } }] }; };
  const d = mkdtempSync(join(tmpdir(), "amness-tier-")); writeFileSync(join(d, "a.txt"), "x");
  await createCodeAgent({ model: withCard(raw, card), cwd: d, memory: false, guidance: false, index: false, ...o }).run("change a.txt");
  return { sys, tools };
}
const LEAN_HIDDEN = ["apply_patch", "sh_start", "memory_save"];

test("a 64k-window model whose profile says tier local gets the short local prompt and the lean tool set", async () => {
  const r = await firstRequest({ window: () => 65_536, tier: "local", tierFrom: "profile" });
  assert.ok(r.sys.startsWith(LOCAL_SYSTEM.slice(0, 60)), r.sys.slice(0, 80));
  for (const t of LEAN_HIDDEN) assert.ok(!r.tools.includes(t), t);
  assert.ok(r.tools.includes("tool_search") && r.tools.includes("edit_file") && r.tools.includes("finish"));
});

test("a guessed local tier changes nothing (not measured yet); a frontier model with an 8k window still gets the small-window profile", async () => {
  const guessed = await firstRequest({ window: () => 65_536, tier: "local", tierFrom: "guess" });
  assert.ok(!guessed.sys.startsWith(LOCAL_SYSTEM.slice(0, 60))); assert.ok(guessed.tools.includes("apply_patch"));
  const small = await firstRequest({ window: () => 8_192, tier: "frontier", tierFrom: "profile" });
  assert.ok(small.sys.startsWith(COMPACT_SYSTEM.slice(0, 60))); assert.ok(!small.tools.includes("apply_patch"));
  const opt = await firstRequest({ window: () => 65_536 }, { tier: "local" });
  assert.ok(opt.sys.startsWith(LOCAL_SYSTEM.slice(0, 60)), "the tier option works without a card tier");
});

test("profile tools: only the listed tools (and finish) are offered, not even through tool_search", async () => {
  const r = await firstRequest({ window: () => 65_536, profile: { tools: ["read_file", "edit_file", "sh"] } });
  assert.deepEqual(r.tools.filter((t) => t !== "tool_search").sort(), ["edit_file", "finish", "read_file", "sh"]);
});

test("eval variant tier:local runs the full harness with the local prompt; an unknown tier is refused", async () => {
  let sys = "";
  const m: Model = async (msgs) => { sys ||= msgs[0].content ?? ""; return { role: "assistant", content: null, tool_calls: [{ id: "f", function: { name: "finish", arguments: '{"summary":"ok"}' } }] } as Message; };
  const v = harnessVariant(m, "tier:local");
  await v.run({ name: "c", task: "t", files: {}, check: "true" }, mkdtempSync(join(tmpdir(), "amness-tv-")));
  assert.ok(sys.startsWith(LOCAL_SYSTEM.slice(0, 60)));
  assert.throws(() => harnessVariant(m, "tier:huge"), /unknown tier/);
});

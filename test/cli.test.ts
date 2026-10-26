import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { box, strip, wrap } from "../cli/ui.ts";
import { defaults, loadConfig, ready, saveConfig, mask } from "../cli/config.ts";
import { formatEvent } from "../cli/format.ts";
import { runDemo } from "../cli/demo.ts";

test("boxes are rectangular, with or without a title", () => {
  for (const b of [box(["hello", "a much longer line here"]), box(["x", "yy"], (s) => s, "Title")]) {
    const w = new Set(b.split("\n").map((l) => strip(l).length));
    assert.equal(w.size, 1, b);
  }
});

test("config round-trips, is private (0600), and env overrides saved values", () => {
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-cfg-"));
  delete process.env.OPENAI_API_KEY; delete process.env.AMNESS_MODEL;
  assert.equal(ready(defaults()), false);
  saveConfig({ ...defaults(), apiKey: "sk-abcdef123456", model: "m1" });
  assert.equal(statSync(join(process.env.AMNESS_HOME, "config.json")).mode & 0o777, 0o600);
  assert.equal(loadConfig().model, "m1"); assert.ok(ready(loadConfig()));
  process.env.AMNESS_MODEL = "from-env"; process.env.OPENAI_API_KEY = "sk-env";
  assert.deepEqual([loadConfig().model, loadConfig().apiKey], ["from-env", "sk-env"]);
  delete process.env.AMNESS_MODEL; delete process.env.OPENAI_API_KEY;
  assert.equal(mask("sk-abcdef123456"), "sk-…3456");
});

test("formatEvent renders every event kind", () => {
  const out = [
    formatEvent({ kind: "tool", name: "sh", args: '{"cmd":"npm test"}', result: "exit=0\nok" }),
    formatEvent({ kind: "tool", name: "sh", args: "{}", result: "ERROR: boom", agent: "general" }),
    ...(["nudge", "repair", "loop", "rejected", "denied", "budget", "tools"] as const).map((kind) => formatEvent({ kind, detail: "d" })),
    formatEvent({ kind: "finish", summary: "s" }),
  ].map(strip);
  assert.match(out[0], /✓ sh npm test/); assert.match(out[1], /general.*✗ sh.*ERROR: boom/);
  assert.equal(out.length, 10); assert.ok(out.every(Boolean));
});

test("guided demo runs headless: every guard fires and the fix lands", async () => {
  const asked: string[] = [];
  const { result, events } = await runDemo({ delayMs: 0, onEvent: () => {}, approve: (r) => (asked.push(r.reason!), false) });
  assert.equal(result.finished, true);
  assert.deepEqual(asked, ["recursive/forced delete"]);
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ["nudge", "repair", "denied", "rejected", "finish"]) assert.ok(kinds.has(k as any), k);
});

test("long box lines wrap instead of truncating, and stay rectangular", () => {
  const long = "model said what it would do but did nothing → pushed back to act, then the workspace path /var/folders/3c/2367n75n7217j7bb60bb9pkw0000gn/T/amness-demo-OhuWPq";
  const b = box([long, "short"]);
  const lines = b.split("\n");
  assert.equal(new Set(lines.map((l) => strip(l).length)).size, 1);
  assert.ok(!b.includes("…"));
  const body = lines.slice(1, -1).map((l) => strip(l).slice(2, -2).trim()).join(" ").replace(/\s+/g, " ");
  for (const word of long.split(" ")) assert.ok(body.includes(word), word);   // nothing lost
  assert.ok(wrap("x".repeat(200), 40).every((l) => strip(l).length <= 40));    // unbreakable word is hard-cut
});

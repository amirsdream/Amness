import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockStore } from "../cli/tui/blocks.ts";

test("kids() returns only the steps that belong to one subagent card, in order, even when two run at once", () => {
  const b = new BlockStore();
  b.toolStart("T1", "task", "{}"); b.toolStart("T2", "task", "{}");
  b.toolStart("a1", "read_file", "{}", "explore", "T1"); b.toolStart("b1", "grep", "{}", "explore", "T2"); b.toolStart("a2", "grep", "{}", "explore", "T1");
  assert.deepEqual(b.kids("T1").map((k) => k.callId), ["a1", "a2"]); assert.deepEqual(b.kids("T2").map((k) => k.callId), ["b1"]); assert.deepEqual(b.kids("none"), []);
});
test("closeRunning closes every spinner with a note", () => {
  const b = new BlockStore(); b.toolStart("x", "task", "{}"); b.toolStart("y", "read_file", "{}", "explore", "x");
  assert.equal(b.closeRunning("interrupted"), 2); assert.ok(b.blocks.every((k: any) => k.status === "fail" && /interrupted/.test(k.result)));
});

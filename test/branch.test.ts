import { test } from "node:test";
import assert from "node:assert/strict";
import { forkSession, newSession, relatives } from "../cli/tui/session.ts";

const sess = () => { const s = newSession("/x", "m"); s.title = "work"; s.messages = [{ role: "user", content: "a" }, { role: "assistant", content: "A" }, { role: "user", content: "b" }, { role: "assistant", content: "B" }] as any; s.turns = [{ at: 0, text: "a", snaps: {} }, { at: 2, text: "b", snaps: {} }] as any; return s; };
test("forkSession keeps turns up to the chosen one, copies instead of sharing, and records its parent", () => {
  const s = sess(), f = forkSession(s, 0);
  assert.equal(f.turns.length, 1); assert.equal(f.messages.length, 2); assert.deepEqual(f.parent, { id: s.id, turn: 0 }); assert.notEqual(f.id, s.id);
  f.messages.push({ role: "user", content: "new" } as any); assert.equal(s.messages.length, 4);
  assert.equal(forkSession(s, 1).messages.length, 4); assert.match(f.title, /^work \(branch /);
});
test("relatives finds ancestors, descendants and siblings but not unrelated conversations", () => {
  const a = sess(), b = forkSession(a, 0), c = forkSession(a, 0), d = forkSession(b, 0), other = sess();
  assert.deepEqual(new Set(relatives([a, b, c, d, other], d.id)), new Set([a.id, b.id, c.id, d.id])); assert.deepEqual(relatives([a, other], other.id), [other.id]);
});

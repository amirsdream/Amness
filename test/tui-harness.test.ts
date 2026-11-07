import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harnessView } from "../cli/tui/harnessinfo.ts";
import { call, KEY, rig, say } from "./helpers/apprig.ts";

const withVisual = async (script: string, fn: () => Promise<void>) => {
  const saved = process.env.VISUAL; process.env.VISUAL = `node -e "require('fs').writeFileSync(process.argv[1], ${JSON.stringify(script).replace(/"/g, "'")})"`;
  try { await fn(); } finally { if (saved === undefined) delete process.env.VISUAL; else process.env.VISUAL = saved; }
};

test("harnessView: defaults, then the model profile, then your settings; guards you switch off add to the profile's", () => {
  const v = harnessView({ harness: { off: ["loop"], maxSteps: 90 } }, { off: ["nudge"], stagnationTurns: 4 });
  assert.equal(v.maxSteps, 90); assert.equal(v.stagnationTurns, 4); assert.equal(v.contextBudget, 60000);
  assert.deepEqual(v.guards.filter((g) => !g.on).map((g) => g.name).sort(), ["loop", "nudge"]);
  assert.equal(v.guards.find((g) => g.name === "nudge")!.byProfile, true);
});

test("/harness switches guards and limits, saves them, and the agent is rebuilt with them", async () => {
  const t = rig([]); await t.start();
  await t.submit("/harness off loop"); await t.submit("/harness steps 80"); await t.submit("/harness stagnation 5"); await t.submit("/harness budget 90000");
  assert.ok(await t.until(() => t.has("context budget → 90000")));
  assert.deepEqual(t.app.cfg.harness, { off: ["loop"], maxSteps: 80, stagnationTurns: 5, contextBudget: 90000 });
  const o = t.app.harnessOptions(); assert.deepEqual(o.off, ["loop"]); assert.equal(o.maxSteps, 80); assert.equal(o.stagnationTurns, 5); assert.equal(o.contextBudget, 90000);
  await t.submit("/harness off nosuch"); assert.ok(await t.until(() => t.has('unknown guard "nosuch"')));
  await t.submit("/harness reset"); assert.ok(await t.until(() => t.app.cfg.harness === undefined));
  await t.key(KEY.ctrlD);
});

test("/edit puts an earlier message in the input; Enter goes back to before it (the file too) and sends the new text", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "two", new: "2" }), say("changed"), say("second answer"), say("redone")], { cfg: { provider: "custom" } });
  await t.start();
  t.app.setMode("acceptEdits");
  await t.submit("change two to 2"); assert.ok(await t.until(() => t.idle() && t.has("changed")));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\n2\n");
  await t.submit("thanks"); assert.ok(await t.until(() => t.idle() && t.has("second answer")));
  await t.submit("/edit 1"); assert.ok(await t.until(() => t.app.editor.text === "change two to 2" && !!t.app.editing));
  assert.ok(t.has("editing your message 1"));
  t.app.editor.setText("leave the file as it is"); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle() && t.has("redone")));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\ntwo\n");                       // the edit after that message was undone
  assert.deepEqual(t.app.session.turns.map((x) => x.text), ["leave the file as it is"]);
  await t.key(KEY.ctrlD);
});

test("Esc while editing an earlier message cancels the edit", async () => {
  const t = rig([say("ok")]); await t.start();
  await t.submit("hello"); assert.ok(await t.until(() => t.idle()));
  await t.submit("/edit 1"); assert.ok(await t.until(() => !!t.app.editing));
  await t.key(KEY.esc); assert.ok(await t.until(() => !t.app.editing && t.app.editor.empty));
  assert.equal(t.app.session.turns.length, 1); await t.key(KEY.ctrlD);
});

test("approving a plan after editing it: the agent is told to follow your version", async () => {
  await withVisual("1. Only fix the parser.\n2. Add one test.", async () => {
    const t = rig([call("exit_plan_mode", { plan: "1. Rewrite everything." }), say("following your plan")]); await t.start();
    t.app.setMode("plan");
    await t.submit("make a plan"); assert.ok(await t.until(() => t.has("after I edit the plan")));
    await t.key("3"); assert.ok(await t.until(() => t.idle() && t.has("following your plan")));
    const tool = t.seen.at(-1)!.msgs.find((m) => m.role === "tool")!;
    assert.match(tool.content!, /Follow this version, not yours:\n\n1\. Only fix the parser\.\n2\. Add one test\./);
    assert.equal(t.app.mode, "default");
    await t.key(KEY.ctrlD);
  });
});

test("/todos edit changes the list and tells the agent with the next message", async () => {
  await withVisual("- [x] read the code\n- [~] fix the bug\n- [ ] add a test", async () => {
    const t = rig([say("noted")]); await t.start();
    t.app.todos = [{ content: "read the code", status: "in_progress" }];
    await t.submit("/todos edit"); assert.ok(await t.until(() => t.app.todos.length === 3));
    assert.deepEqual(t.app.todos.map((x) => x.status), ["done", "in_progress", "pending"]);
    await t.submit("go on"); assert.ok(await t.until(() => t.idle() && t.has("noted")));
    const user = t.seen.at(-1)!.msgs.filter((m) => m.role === "user").at(-1)!.content!;
    assert.match(user, /I changed the todo list[\s\S]*- \[~\] fix the bug/);
    await t.key(KEY.ctrlD);
  });
});

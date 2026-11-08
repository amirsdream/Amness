import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, isSmallTalk, type Message, type Model } from "../src/index.ts";

test("small talk: greetings, thanks and ok are recognised; anything with a request in it is not", () => {
  for (const s of ["hi", "Hi!", "hey there", "hello amness", "thanks!", "thank you", "ok", "good morning", "how are you?", "hi hi", "👋 hi"]) assert.ok(isSmallTalk(s), s);
  for (const s of ["", "hi, fix the failing test", "hello, what does src/app.ts do?", "thanks, now run the tests", "ok go ahead and refactor it"]) assert.ok(!isSmallTalk(s), s);
});

/** A project with an AGENTS.md and an agent whose model says the given replies; returns what each request sent. */
function setup(replies: Message[]) {
  const d = mkdtempSync(join(tmpdir(), "amness-hi-")); writeFileSync(join(d, "AGENTS.md"), "RULE-FROM-AGENTS-MD: run npm test before finishing.\n"); writeFileSync(join(d, "a.txt"), "teh\n");
  const q = [...replies], sent: Message[][] = [];
  const model: Model = async (m) => { sent.push(m.map((x) => ({ ...x }))); return q.shift() ?? { role: "assistant", content: "ok" }; };
  return { agent: createCodeAgent({ model, cwd: d, memory: false, chat: true, permissions: { mode: () => "yolo" } }), sent };
}
const userTexts = (msgs: Message[]) => msgs.filter((m) => m.role === "user").map((m) => m.content ?? "");

test("a new session: hi is sent as it is and answered in words, even when the reply says I'll; the project guidance comes with the first real request", async () => {
  const { agent, sent } = setup([{ role: "assistant", content: "Hi! I'll be glad to help with this project." }, { role: "assistant", content: "Hello again!" }, { role: "assistant", content: "Fixed the typo." }]);
  let r = await agent.chat([], "hi");
  assert.equal(sent.length, 1);                                                         // no "do it now with a tool call" nudge
  assert.deepEqual(userTexts(sent[0]), ["hi"]);                                         // no AGENTS.md, skills or notes attached to a greeting
  r = await agent.chat(r.messages, "hi");
  assert.equal(sent.length, 2); assert.equal(userTexts(sent[1]).at(-1), "hi");
  await agent.chat(r.messages, "fix the typo in a.txt");
  assert.match(userTexts(sent[2]).at(-1)!, /fix the typo in a\.txt[\s\S]*RULE-FROM-AGENTS-MD/);   // saying hi first does not lose the guidance
});

test("the nudge still pushes a real task that stops at describing, but not a reply that asks the user something", async () => {
  let s = setup([{ role: "assistant", content: "I'll look at a.txt and fix it." }, { role: "assistant", content: "Done." }]);
  await s.agent.chat([], "fix the typo in a.txt");
  assert.equal(s.sent.length, 2); assert.match(userTexts(s.sent[1]).at(-1)!, /Do it now with a tool call/);
  s = setup([{ role: "assistant", content: "I'll fix it, but which typo do you mean?" }]);
  await s.agent.chat([], "fix the typo");
  assert.equal(s.sent.length, 1);
});

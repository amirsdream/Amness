import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecision, reviewedApprove, type Message, type Model } from "../src/index.ts";

const says = (content: string): Model => (async () => ({ role: "assistant", content }) as Message) as Model;
const req = { name: "sh", args: { cmd: "npm test" }, reason: "runs a command" };

test("approves what the reviewer clears, and passes everything else to the user", async () => {
  let asked = 0; const inner = () => { asked++; return false; };
  assert.equal(await reviewedApprove(inner, { model: says('{"decision":"approve","reason":"runs the project tests"}') })(req), true); assert.equal(asked, 0);
  assert.equal(await reviewedApprove(inner, { model: says('{"decision":"escalate","reason":"unsure"}') })(req), false); assert.equal(asked, 1);
});

test("the floor, a broken reviewer and garbage output all reach the user; nothing the reviewer says can approve a floor call", async () => {
  let asked = 0; const inner = () => { asked++; return "no"; }; let reviewerCalls = 0;
  const yes: Model = (async () => { reviewerCalls++; return { role: "assistant", content: '{"decision":"approve","reason":"fine"}' } as Message; }) as Model;
  assert.equal(await reviewedApprove(inner, { model: yes })({ ...req, floor: true }), "no"); assert.equal(reviewerCalls, 0);
  const boom: Model = (async () => { throw new Error("down"); }) as Model;
  assert.equal(await reviewedApprove(inner, { model: boom })(req), "no");
  assert.equal(await reviewedApprove(inner, { model: says("sure, go ahead") })(req), "no"); assert.equal(asked, 3);
});

test("decisions are reported with the tool name; parseDecision is strict about what counts as approval", async () => {
  const seen: string[] = []; await reviewedApprove(() => false, { model: says('Here: {"decision":"approve","reason":"read only"}'), onDecision: (d) => seen.push(`${d.tool}:${d.decision}:${d.reason}`) })(req);
  assert.deepEqual(seen, ["sh:approve:read only"]);
  assert.equal(parseDecision('{"decision":"APPROVE"}').decision, "escalate"); assert.equal(parseDecision("{").decision, "escalate");
});

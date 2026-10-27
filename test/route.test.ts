import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, createCodeAgent, isRetryable, withFallback, type Message, type Model } from "../src/index.ts";

const say = (c: string): Message => ({ role: "assistant", content: c });
let n = 0;
const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "m" + ++n, function: { name, arguments: JSON.stringify(args) } }] });

test("isRetryable: overload, rate limits, server errors and network failures yes; auth, bad requests and aborts no", () => {
  for (const e of [new ApiError(429, "slow down"), new ApiError(503, "x"), new ApiError(408, "t"), new Error("fetch failed"), Object.assign(new Error("x"), { code: "ECONNRESET" }), new Error("HTTP 529: overloaded")]) assert.ok(isRetryable(e), String(e));
  for (const e of [new ApiError(401, "bad key"), new ApiError(400, "bad request"), Object.assign(new Error("aborted"), { name: "AbortError" }), new Error("some bug")]) assert.ok(!isRetryable(e), String(e));
});

test("withFallback: answers from the fallback only on retryable errors, passes everything else through, reports the switch", async () => {
  const seen: string[] = [], down: Model = async () => { throw new ApiError(503, "overloaded"); }, bad: Model = async () => { throw new ApiError(401, "no"); }, ok: Model = async () => say("from fallback");
  const m = withFallback(down, ok, () => seen.push("switched"));
  assert.equal((await m([], [])).content, "from fallback"); assert.deepEqual(seen, ["switched"]);
  await assert.rejects(withFallback(bad, ok)([], []), /no/);
  const fine = withFallback(async () => say("primary"), ok); assert.equal((await fine([], [])).content, "primary");
  const ac = new AbortController(); ac.abort(); await assert.rejects(withFallback(down, ok)([], [], { signal: ac.signal }), /overloaded/);
  const a: Model = async () => say("a"); a.appendOnly = true; assert.equal(withFallback(a, ok).appendOnly, true);
});

test("roles: the explorer, the handoff note and the reviewer's model come from `models`; unset roles use the main model", async () => {
  const d = mkdtempSync(join(tmpdir(), "amness-rt-")); writeFileSync(join(d, "a.txt"), "x\n");
  const who: string[] = [];
  const named = (name: string, replies: (m: Message[]) => Message): Model => async (m) => (who.push(name), replies(m));
  const main = named("main", (m) => (m.filter((x) => x.role === "assistant").length === 0 ? call("task", { description: "look around" }) : say("done")));
  const explore = named("explore", () => call("finish", { summary: "found nothing" })), compact = named("compact", () => say("GOAL: x\nDONE: y")), review = named("review", () => say("[]"));
  const agent = createCodeAgent({ model: main, cwd: d, memory: false, guidance: false, chat: true, models: { explore, compact, review } });
  await agent.chat([], "explore the repo please");
  assert.deepEqual(who, ["main", "explore", "main"]);
  const msgs = (await agent.chat([], "hi")).messages; who.length = 0;
  const h = await agent.compact(msgs); assert.equal(who.at(-1), "compact"); assert.match(h.note, /GOAL/);
  who.length = 0; const plain = createCodeAgent({ model: named("only", () => say("ok")), cwd: d, memory: false, guidance: false, chat: true, models: {} });
  await plain.chat([], "hi"); assert.deepEqual(who, ["only"]);
});

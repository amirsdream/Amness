import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, createHarness, defineTool, type Event, type Message, type Model } from "../src/index.ts";
import { ReadLedger, ToolCache, isPointer, repairMarkers, repairPointers, stillAbove } from "../src/cache.ts";
import { supersede } from "../src/harness.ts";

let n = 0;
const call = (...cs: [string, unknown][]): Message => ({ role: "assistant", content: null, usage: { prompt_tokens: 100, total_tokens: 110 }, tool_calls: cs.map(([name, a]) => ({ id: `k${++n}`, function: { name, arguments: JSON.stringify(a) } })) });
const scripted = (...replies: Message[]) => { const seen: Message[][] = []; const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return replies.shift()!; }; return { model, seen }; };
const fin = call(["finish", { summary: "done" }]);
const tmp = () => mkdtempSync(join(tmpdir(), "amness-c-"));
const toolMsgs = (seen: Message[][]) => seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!);

function counted() {
  let runs = 0, value = "v1";
  const read = defineTool<{ p: string }>({ name: "read", description: "", schema: { type: "object", properties: { p: { type: "string" } } }, readOnly: true, cacheable: true, stamp: () => value, run: ({ p }) => { runs++; return `contents of ${p} ${value} ` + "x".repeat(400); } });
  const write = defineTool({ name: "write", description: "", schema: { type: "object" }, run: () => "ok" });
  return { read, write, runs: () => runs, set: (v: string) => { value = v; } };
}

test("a repeated pure read is not run again, and is answered with a one-line pointer while the first result is still above", async () => {
  const t = counted(), { model, seen } = scripted(call(["read", { p: "a" }]), call(["read", { p: "a" }]), fin);
  const cache = new ToolCache(); await createHarness({ model, tools: [t.read], toolCache: cache, stagnationTurns: 0 }).run("go");
  assert.equal(t.runs(), 1); assert.deepEqual([cache.hits, cache.pointers, cache.misses], [1, 1, 1]); assert.ok(cache.saved > 400);
  const out = toolMsgs(seen); assert.match(out[0], /contents of a v1/); assert.match(out[1], /^\[unchanged since call k\d+:/);
});

test("any state-changing tool, a changed stamp, or the TTL invalidates the stored read", async () => {
  const t = counted(), { model } = scripted(call(["read", { p: "a" }]), call(["write", {}]), call(["read", { p: "a" }]), call(["read", { p: "b" }]), call(["read", { p: "b" }]), fin);
  await createHarness({ model, tools: [t.read, t.write], toolCache: new ToolCache(), stagnationTurns: 0 }).run("go");
  assert.equal(t.runs(), 3, "read a, (write), read a again, read b; the second read b was a hit");
  const c = new ToolCache(1000); c.set("k", { world: 1, stamp: "s", result: "r", callId: "x" }, 0);
  assert.ok(c.get("k", 1, "s", 500)); assert.equal(c.get("k", 1, "s2", 500), undefined); c.set("k", { world: 1, stamp: "s", result: "r", callId: "x" }, 0); assert.equal(c.get("k", 1, "s", 2000), undefined); c.set("k", { world: 1, stamp: "s", result: "r", callId: "x" }, 0); assert.equal(c.get("k", 2, "s", 10), undefined);
});

test("when the first output has been shortened, the repeat gets the full stored result, not a pointer to nothing", async () => {
  const t = counted(), { model, seen } = scripted(call(["read", { p: "a" }]), call(["read", { p: "b" }]), call(["read", { p: "a" }]), fin);
  let first: Message | undefined;
  await createHarness({ model, tools: [t.read], toolCache: new ToolCache(), stagnationTurns: 0, context: (msgs) => { first ??= msgs.find((m) => m.role === "tool"); if (msgs.length > 5 && first) first.content = "[old output elided, 400 chars; call the tool again if you need it]"; } }).run("go");
  assert.match(toolMsgs(seen)[2], /contents of a v1/); assert.equal(t.runs(), 2, "served from the store without running the tool again");
});

test("pointers are repaired when their original is shortened, and a pointer never makes supersede() drop the original", () => {
  const msgs: Message[] = [{ role: "user", content: "t" },
    { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "read", arguments: '{"p":"x"}' } }] }, { role: "tool", tool_call_id: "a", content: "full text ".repeat(60) },
    { role: "assistant", content: null, tool_calls: [{ id: "b", function: { name: "read", arguments: '{"p":"x"}' } }] }, { role: "tool", tool_call_id: "b", content: "[unchanged since call a: same result as that call, which is still above in this conversation]" },
    ...Array.from({ length: 8 }, (_, i): Message[] => [{ role: "assistant", content: `step ${i}` }, { role: "user", content: "go on" }]).flat()];
  assert.ok(isPointer(msgs[4])); assert.equal(supersede(msgs, 6), 0); assert.ok(stillAbove(msgs, "a"), "the original survives");
  msgs[2].content = "[old output elided, 600 chars; call the tool again if you need it]"; assert.equal(repairPointers(msgs), 1); assert.match(msgs[4].content!, /^\[old output elided/);
});

test("code agent: read_file repeats cost a pointer, an edit makes the next read real again, and untrusted or moving tools are never cached", async () => {
  const dir = tmp(); writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const { model, seen } = scripted(call(["read_file", { path: "a.txt" }]), call(["read_file", { path: "a.txt" }]), call(["write_file", { path: "a.txt", content: "one\nTWO\n" }]), call(["read_file", { path: "a.txt" }]), fin);
  const events: Event[] = []; await createCodeAgent({ model, cwd: dir, memory: false, guidance: false, index: false, onEvent: (e) => events.push(e), approve: () => true }).run("check a.txt");
  const out = toolMsgs(seen).filter((s) => !/^ok|written|wrote/i.test(s)); assert.match(out[0], /1\tone/); assert.match(out[1], /^\[unchanged since call/); assert.match(out.at(-1)!, /2\tTWO/);
});

test("response cache: an identical request is answered from disk; trials stay independent; a different salt or request misses; onText still streams", async () => {
  const { cachedModel } = await import("../src/respcache.ts");
  const dir = tmp(); let calls = 0;
  const raw: Model = async (msgs) => { calls++; return { role: "assistant", content: `reply ${calls} to ${msgs.at(-1)!.content}`, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; };
  const ask = (m: Model, text: string, onText?: (d: string) => void) => m([{ role: "user", content: text }], [], { onText });
  const first = cachedModel(raw, { dir, salt: "m1" });
  const a1 = await ask(first, "hi"), a2 = await ask(first, "hi");                                  // the same request twice in one process: two independent trials
  assert.equal(calls, 2); assert.notEqual(a1.content, a2.content);
  const again = cachedModel(raw, { dir, salt: "m1" }), streamed: string[] = [];                    // a rerun of the experiment in a new process
  const b1 = await ask(again, "hi", (d) => streamed.push(d)), b2 = await ask(again, "hi");
  assert.equal(calls, 2, "nothing went to the model"); assert.deepEqual([b1.content, b2.content], [a1.content, a2.content]); assert.deepEqual(streamed, [a1.content]); assert.deepEqual(again.stats, { hits: 2, fresh: 0 });
  assert.equal(b1.usage?.total_tokens, 15, "token counts are those of the original call");
  await ask(cachedModel(raw, { dir, salt: "m2" }), "hi"); await ask(cachedModel(raw, { dir, salt: "m1" }), "other");
  assert.equal(calls, 4, "another model or another request is a miss");
});

test("plan cache: a finished task leaves a plan, a similar task is offered it, a different one is not, and two failures retire it", async () => {
  const { PlanCache, planFrom, planBlock, similarity, words } = await import("../src/plancache.ts");
  const dir = tmp(), pc = new PlanCache(join(dir, "plans"));
  const msgs: Message[] = [{ role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "edit_file", arguments: '{"path":"src/auth.ts"}' } }, { id: "2", function: { name: "sh", arguments: '{"cmd":"npm test"}' } }] }];
  const plan = planFrom(msgs, "fixed the login redirect and added a test");
  assert.match(plan, /Changed: src\/auth\.ts/); assert.match(plan, /npm test/); assert.match(plan, /login redirect/);
  pc.record("Fix the login redirect bug in the auth module", plan);
  const hit = pc.find("fix the login redirect bug in auth"); assert.ok(hit && hit.similarity > 0.5); assert.match(planBlock(hit!.plan, hit!.similarity), /starting point only/);
  assert.equal(pc.find("add a dark mode toggle to the settings page"), undefined);
  assert.ok(similarity(words("a b c"), words("x y z")) === 0);
  pc.outcome(hit!.plan.id, false); pc.outcome(hit!.plan.id, false); assert.equal(pc.find("fix the login redirect bug in auth"), undefined, "retired after two misses");
});

test("code agent with plans on: the second similar task is offered the first one's plan, and it is not offered when the option is off", async () => {
  const dir = tmp(); writeFileSync(join(dir, "a.txt"), "x\n");
  const run = async (plans: boolean, task: string) => { const { model, seen } = scripted(call(["write_file", { path: "a.txt", content: "y\n" }]), fin); const events: Event[] = []; await createCodeAgent({ model, cwd: dir, memory: false, guidance: false, index: false, plans, approve: () => true, onEvent: (e) => events.push(e) }).run(task); return { first: seen[0].find((m) => m.role === "user")!.content!, events }; };
  await run(true, "rename the variable in a.txt to something clearer and keep tests green");
  const again = await run(true, "rename the variable in a.txt to something clearer, keep the tests green");
  assert.match(again.first, /A plan from a similar past task[\s\S]*Changed: a\.txt/); assert.ok(again.events.some((e) => e.kind === "plan"));
  const off = await run(false, "rename the variable in a.txt to something clearer and keep tests green"); assert.doesNotMatch(off.first, /similar past task/);
});

test("prefixCacheRate reads vLLM's metrics page and says nothing when the server has none", async () => {
  const { prefixCacheRate } = await import("../cli/models.ts");
  const page = 'vllm:prefix_cache_queries_total{engine="0"} 1000.0\nvllm:prefix_cache_hits_total{engine="0"} 860.0\n';
  const ok = (async (url: string) => (String(url).endsWith("/metrics") ? ({ ok: true, text: async () => page } as Response) : ({ ok: false } as Response))) as unknown as typeof fetch;
  assert.equal(await prefixCacheRate("http://h:8000/v1", ok), 0.86);
  assert.equal(await prefixCacheRate("http://h:8000/v1", (async () => ({ ok: false }) as Response) as unknown as typeof fetch), undefined);
});

// ------------------------------------------------------------------------------------------------ read overlap (ReadLedger)
const numbered = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `${a + i}\tline ${a + i}`).join("\n");
const always = () => true;

test("ReadLedger: a second read of an unchanged file gets only the lines it did not have, with a marker for the rest", () => {
  const l = new ReadLedger();
  assert.equal(l.dedupe("f", "s1", numbered(1, 20), "c1", always), numbered(1, 20));
  const out = l.dedupe("f", "s1", numbered(10, 30), "c2", always);
  const rows = out.split("\n"); assert.equal(rows[0], "(lines 10-20 unchanged: already above in the output of call c1)"); assert.equal(rows[1], "21\tline 21"); assert.equal(rows.length, 11);
  assert.ok(l.saved > 50);
});

test("ReadLedger: a short overlap is sent again, a changed file or a shortened earlier output is never marked", () => {
  const l = new ReadLedger(); l.dedupe("f", "s1", numbered(1, 10), "c1", always);
  assert.equal(l.dedupe("f", "s1", numbered(8, 14), "c2", always), numbered(8, 14));                // only 3 shared lines: not worth a marker
  const l2 = new ReadLedger(); l2.dedupe("f", "s1", numbered(1, 30), "c1", always);
  assert.equal(l2.dedupe("f", "s2", numbered(1, 30), "c2", always), numbered(1, 30));               // the file changed (new stamp)
  assert.equal(l2.dedupe("f", "s2", numbered(1, 30), "c3", (id) => id !== "c2"), numbered(1, 30));  // c2's output has been shortened since
});

test("ReadLedger: non-numbered lines (a guidance note, a cut marker) and a second file are left alone", () => {
  const l = new ReadLedger(); l.dedupe("a", "s", numbered(1, 12), "c1", always);
  const text = numbered(1, 12) + "\n\n[AGENTS.md note]";
  assert.equal(l.dedupe("a", "s", text, "c2", always), "(lines 1-12 unchanged: already above in the output of call c1)\n\n[AGENTS.md note]");
  assert.equal(l.dedupe("b", "s", numbered(1, 12), "c3", always), numbered(1, 12));
});

test("repairMarkers: a marker whose source output was shortened says to read again instead of pointing at nothing", () => {
  const msgs: Message[] = [{ role: "tool", tool_call_id: "c1", content: numbered(1, 12) }, { role: "tool", tool_call_id: "c2", content: "(lines 1-12 unchanged: already above in the output of call c1)\n13\tx" }];
  assert.equal(repairMarkers(msgs), 0);
  msgs[0].content = "[old output elided, 90 chars]";
  assert.equal(repairMarkers(msgs), 1); assert.match(msgs[1].content!, /^\(lines 1-12: the earlier output was shortened; read them again/); assert.match(msgs[1].content!, /13\tx$/);
});

test("in a run, reading a file in overlapping pieces sends each line once; the guard can be switched off", async () => {
  const dir = tmp(); writeFileSync(join(dir, "f.txt"), Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
  const run = async (off: string[]) => {
    const { model, seen } = scripted(call(["read_file", { path: "f.txt", start: 1, end: 30 }]), call(["read_file", { path: "f.txt", start: 10, end: 45 }]), fin);
    await createCodeAgent({ model, cwd: dir, off, stagnationTurns: 0 } as never).run("go"); return toolMsgs(seen);
  };
  const on = await run([]), off = await run(["readdelta"]);
  assert.match(on[1], /^\(lines 10-30 unchanged: already above in the output of call k\d+\)\n31\trow 31/); assert.ok(!/10\trow 10/.test(on[1]));
  assert.match(off[1], /10\trow 10/); assert.ok(on[1].length < off[1].length);
});

test("ReadLedger: lines from two earlier calls get two markers, each naming its own call", () => {
  const l = new ReadLedger(); l.dedupe("f", "s", numbered(1, 10), "A", always); l.dedupe("f", "s", numbered(11, 20), "B", always);
  const out = l.dedupe("f", "s", numbered(1, 20), "C", always).split("\n");
  assert.deepEqual(out, ["(lines 1-10 unchanged: already above in the output of call A)", "(lines 11-20 unchanged: already above in the output of call B)"]);
});

test("supersede keeps a read that a later marker points at; a tool with overlap but no stamp is never deduped", async () => {
  const msgs: Message[] = [
    { role: "assistant", content: null, tool_calls: [{ id: "A", function: { name: "read_file", arguments: '{"path":"f"}' } }] }, { role: "tool", tool_call_id: "A", content: numbered(1, 40) },
    { role: "assistant", content: null, tool_calls: [{ id: "B", function: { name: "read_file", arguments: '{"path":"f"}' } }] }, { role: "tool", tool_call_id: "B", content: "(lines 1-40 unchanged: already above in the output of call A)" },
    ...Array.from({ length: 8 }, (_, i): Message => ({ role: "user", content: `pad ${i}` })),
  ];
  supersede(msgs, 6, () => true); assert.match(msgs[1].content!, /^1\tline 1/);
  const dir = tmp(); writeFileSync(join(dir, "f.txt"), "x\n".repeat(40));
  const t = defineTool<{ path: string }>({ name: "rd", description: "", schema: { type: "object" }, readOnly: true, overlap: true, run: () => numbered(1, 40) });
  const { model, seen } = scripted(call(["rd", { path: "f" }]), call(["rd", { path: "f" }]), fin);
  await createHarness({ model, tools: [t], toolCache: false, stagnationTurns: 0 }).run("go");
  assert.match(toolMsgs(seen)[1], /^1\tline 1/);
});

test("re-reading a file whose first read was condensed delivers the lines that were cut (dedupe before condense), and the system prompt names the working directory", async () => {
  const dir = tmp(); writeFileSync(join(dir, "syn.txt"), Array.from({ length: 110 }, (_, i) => `word${i + 1}, ${"synonym ".repeat(6)}end`).join("\n") + "\n");   // ~7 KB: over the 6,000-character cap
  const { model, seen } = scripted(call(["read_file", { path: "syn.txt" }]), call(["read_file", { path: "syn.txt", start: 1, end: 110 }]), fin);
  await createCodeAgent({ model, cwd: dir, stagnationTurns: 0 } as never).run("go");
  const [first, second] = toolMsgs(seen);
  assert.match(first, /chars cut/); assert.ok(!/^60\tword60,/m.test(first));                     // the first read lost its middle
  assert.match(second, /^60\tword60,/m); assert.match(second, /unchanged: already above/); assert.doesNotMatch(second, /chars cut/);
  assert.match(String(seen[0][0].content), new RegExp(`Working directory: ${dir.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, defineTool, type Event, type Message, type Model } from "../src/index.ts";
import { calibration, dropOldest, estimateTokens, fit, isOverflow, mechanicalNote, requestedFromError, shrinkArgs, tailStart, windowFromError } from "../src/context.ts";

// A server with a small window: it refuses a request that does not fit, the way vLLM does. It counts at 3 characters per token, harsher than our estimate (3.5), so passing means a real safety margin.
const CHARS = (msgs: Message[], specs: unknown[]) => msgs.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ?? []).reduce((k, c) => k + c.function.arguments.length + c.function.name.length, 0) + 12, 0) + JSON.stringify(specs).length;
function smallServer(window: number, steps: number, o: { say?: boolean } = {}) {
  let n = 0, peak = 0, handoffs = 0;
  const model: Model = async (msgs, specs) => {
    const tokens = Math.ceil(CHARS(msgs, specs) / 3); peak = Math.max(peak, tokens);
    if (tokens > window) throw new Error(o.say === false ? "context length exceeded" : `This model's maximum context length is ${window} tokens. However, you requested ${tokens} tokens in the messages.`);
    if (msgs.at(-1)?.content?.startsWith("Your context is about to be reset")) { handoffs++; return { role: "assistant", content: "GOAL: read every file\nDONE: files 1.." + n + "\nNEXT: keep reading" }; }
    if (n >= steps) return { role: "assistant", content: null, tool_calls: [{ id: `f${n}`, function: { name: "finish", arguments: '{"summary":"all read"}' } }] };
    n++; return { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, function: { name: "read", arguments: JSON.stringify({ path: `file${n}.txt` }) } }] };
  };
  return { model, stats: () => ({ peak, handoffs, calls: n }) };
}
// Tool definitions and a system prompt about the size of a real harness (about 1.5k tokens), so an 8k window is genuinely tight.
const read = defineTool<{ path: string }>({ name: "read", description: "Read a file. " + "It returns the text of the file. ".repeat(40), schema: { type: "object", properties: { path: { type: "string" } } }, run: ({ path }) => `contents of ${path}\n` + Array.from({ length: 120 }, (_, i) => `line ${i} of ${path}: compute(${i * 7}) + helper_${i}();`).join("\n") });
const SYSTEM = "You are an agent. ".repeat(120);

test("without context management (`off: [\"compact\"]`) an 8k window kills the run with a context-length error: what Qwen on a small server hit", async () => {
  const s = smallServer(8192, 40);
  await assert.rejects(createHarness({ model: s.model, tools: [read], system: SYSTEM, maxSteps: 60, stagnationTurns: 0, off: ["compact"] }).run("read every file"), /maximum context length/);
});

test("with a context window the same run finishes, never sends more than the window, and hands off when shrinking is not enough", async () => {
  const s = smallServer(8192, 40), events: Event[] = [];
  const r = await createHarness({ model: s.model, tools: [read], system: SYSTEM, maxSteps: 60, stagnationTurns: 0, contextWindow: 8192, onEvent: (e) => events.push(e) }).run("read every file");
  assert.equal(r.finished, true); assert.equal(r.text, "all read");
  assert.ok(s.stats().peak <= 8192, `peak ${s.stats().peak}`);
  assert.ok(events.some((e) => e.kind === "trim"), "old output was shrunk");
  assert.ok(!events.some((e) => e.kind === "trim" && /overflow/.test((e as any).what)), "no overflow was needed to learn the limit");
});

test("the task survives every handoff and the newest turn is always present", async () => {
  const s = smallServer(6000, 150);
  const r = await createHarness({ model: s.model, tools: [read], system: "short", maxSteps: 200, stagnationTurns: 0, contextWindow: 6000 }).run("TASK: read every file");
  assert.equal(r.finished, true); assert.ok(s.stats().handoffs >= 1, "a 6k window over 60 big reads must roll over at least once");
  assert.match(r.messages.find((m) => m.role === "user")!.content!, /TASK: read every file/);
});

test("no window given: a context-length error that states the window is learned from, and the run continues", async () => {
  const s = smallServer(8192, 40), learned: number[] = [];
  const r = await createHarness({ model: s.model, tools: [read], system: SYSTEM, maxSteps: 60, stagnationTurns: 0, onWindow: (w) => learned.push(w) }).run("read every file");
  assert.equal(r.finished, true); assert.deepEqual(learned, [8192]);
});

test("no window given and an error that does not state it: the harness guesses from its own estimate and recovers", async () => {
  const s = smallServer(8192, 40, { say: false });
  const r = await createHarness({ model: s.model, tools: [read], system: SYSTEM, maxSteps: 60, stagnationTurns: 0 }).run("read every file");
  assert.equal(r.finished, true);
});

test("an error that is not about the context is not swallowed", async () => {
  const bad: Model = async () => { throw new Error("401 invalid api key"); };
  await assert.rejects(createHarness({ model: bad, tools: [read], contextWindow: 8192 }).run("x"), /401/);
});

test("unit: overflow detection and window parsing cover the common servers", () => {
  for (const m of ["This model's maximum context length is 8192 tokens", "the request exceeds the available context size", "prompt is too long: 250000 tokens > 200000 maximum", "context_length_exceeded", "Input is too long for requested model", "n_ctx = 4096 exceeded"]) assert.ok(isOverflow(new Error(m)), m);
  assert.ok(!isOverflow(new Error("rate limit exceeded")));
  assert.equal(windowFromError(new Error("This model's maximum context length is 8192 tokens")), 8192);
  assert.equal(windowFromError(new Error("n_ctx = 4096")), 4096);
  assert.equal(windowFromError(new Error("context length exceeded")), undefined);
});

test("unit: shrinkArgs keeps the arguments valid JSON; tailStart never starts on a tool result; dropOldest keeps the task and the newest turns", () => {
  const body = "x".repeat(2000);
  const msgs: Message[] = [
    { role: "system", content: "s" }, { role: "user", content: "task" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: body }) } }] }, { role: "tool", tool_call_id: "1", content: "ok" },
    { role: "assistant", content: null, tool_calls: [{ id: "2", function: { name: "read", arguments: '{"path":"b"}' } }] }, { role: "tool", tool_call_id: "2", content: "y".repeat(3000) },
    { role: "assistant", content: null, tool_calls: [{ id: "3", function: { name: "read", arguments: '{"path":"c"}' } }] }, { role: "tool", tool_call_id: "3", content: "z".repeat(3000) },
  ];
  assert.ok(shrinkArgs(msgs, 4) > 1500); const a = JSON.parse(msgs[2].tool_calls![0].function.arguments); assert.equal(a.path, "a.ts"); assert.match(a.content, /1900 chars elided/);
  for (const t of [0, 10, 500, 5000]) { const i = tailStart(msgs, t); assert.notEqual(msgs[i].role, "tool"); assert.ok(i >= 1); }
  const before = estimateTokens(msgs); const r = fit(msgs, [], 300, 100, true);
  assert.ok(r.saved > 0 && estimateTokens(msgs) < before); assert.equal(msgs[1].content, "task");
  assert.ok(msgs.at(-1)!.content!.startsWith("z") || msgs.at(-1)!.content!.startsWith("["), "the newest result is still there");
  const only: Message[] = [{ role: "user", content: "t" }, { role: "assistant", content: "hi" }]; assert.equal(dropOldest(only, [], 1), 0);
});

test("unit: the provider's own token count calibrates our estimate; the mechanical note names the files and commands", () => {
  assert.equal(requestedFromError(new Error("you requested 8472 tokens (7972 in the messages)")), 8472);
  assert.equal(requestedFromError(new Error("prompt is too long: 250000 tokens > 200000 maximum")), 250000);
  assert.equal(requestedFromError(new Error("context length exceeded")), undefined);
  assert.equal(calibration(1200, 1000), 1.2); assert.equal(calibration(10, 1000), 0.6); assert.equal(calibration(9000, 1000), 2.5); assert.equal(calibration(0, 1000), 1);
  const note = mechanicalNote([{ role: "user", content: "task" }, { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "write_file", arguments: '{"path":"src/a.ts","content":"x"}' } }, { id: "2", function: { name: "sh", arguments: '{"command":"npm test"}' } }] }, { role: "assistant", content: "tests pass, now docs" }]);
  assert.match(note, /write_file src\/a\.ts/); assert.match(note, /npm test/); assert.match(note, /tests pass, now docs/);
  assert.match(mechanicalNote([{ role: "user", content: "task" }, { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "sh", arguments: '{"cmd":"npm run build"}' } }] }]), /COMMANDS: npm run build/);   // the sh tool's argument is cmd
});

const tiny = defineTool<{ path: string }>({ name: "read", description: "Read a file.", schema: { type: "object", properties: { path: { type: "string" } } }, run: ({ path }) => `${path}: ` + "x".repeat(190) });
test("when even the handoff request overflows, the harness asks again with less, then writes the note itself and carries on", async () => {
  let n = 0, asked = 0;
  const model: Model = async (msgs) => {
    if (msgs.at(-1)?.content?.startsWith("Your context is about to be reset")) { asked++; throw new Error("This model's maximum context length is 2048 tokens"); }
    const tokens = Math.ceil(CHARS(msgs, []) / 3); if (tokens > 2048) throw new Error("This model's maximum context length is 2048 tokens");
    n++; return n > 60 ? { role: "assistant", content: null, tool_calls: [{ id: "f", function: { name: "finish", arguments: '{"summary":"done"}' } }] } : { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, function: { name: "read", arguments: JSON.stringify({ path: `p${n}` }) } }] };
  };
  const events: Event[] = [];
  const r = await createHarness({ model, tools: [tiny], system: "s", maxSteps: 90, stagnationTurns: 0, contextWindow: 2048, onEvent: (e) => events.push(e) }).run("TASK");
  assert.equal(r.finished, true); assert.ok(asked >= 3, "it tried the model three times"); assert.ok(events.some((e) => e.kind === "rollover" && /written automatically/.test((e as any).detail)));
});

test("small window profile: a bare 'hi' sends a short system prompt, few tools and compact blocks, and a left-out tool is still found with tool_search", async () => {
  const { createCodeAgent } = await import("../src/index.ts");
  const { mkdtempSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const sent: { msgs: Message[]; names: string[] }[] = [];
  const replies: Message[] = [{ role: "assistant", content: null, tool_calls: [{ id: "s", function: { name: "tool_search", arguments: '{"query":"memory save"}' } }] }, { role: "assistant", content: "ok" }];
  const model: Model = async (msgs, specs) => { sent.push({ msgs: msgs.map((m) => ({ ...m })), names: specs.map((s) => s.name) }); return replies.shift()!; };
  const mk = (contextWindow?: number) => createCodeAgent({ model, cwd: mkdtempSync(join(tmpdir(), "amness-s-")), chat: true, index: false, contextWindow, stagnationTurns: 0 } as never);
  await mk().run("hi"); const big = sent.shift()!; sent.length = 0; replies.push({ role: "assistant", content: null, tool_calls: [{ id: "s", function: { name: "tool_search", arguments: '{"query":"memory save"}' } }] }, { role: "assistant", content: "ok" });
  await mk(8192).run("hi"); const small = sent.shift()!, after = sent.shift()!;
  assert.ok(big.names.length >= 15 && small.names.length <= 10, `${big.names.length} tools vs ${small.names.length}`);
  assert.ok(!small.names.includes("memory_save") && small.names.includes("read_file") && small.names.includes("edit_file") && small.names.includes("tool_search"));
  assert.ok(small.msgs[0].content!.length < big.msgs[0].content!.length / 2, "short system prompt");
  assert.ok(after.names.includes("memory_save"), "the tool the model asked for is now loaded");
});

test("compactSpec keeps names, types, required lists and enums, and shortens the descriptions; closestName fixes a mistyped tool name", async () => {
  const { compactSpec, closestName } = await import("../src/context.ts");
  const spec = { name: "list_files", description: "List files in the workspace (skips node_modules, .git, dist). Max 300. More detail nobody needs.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "the folder, relative" }, mode: { type: "string", enum: ["a", "b"] } } } } as never;
  const c = compactSpec(spec) as { description: string; parameters: any };
  assert.equal(c.description, "List files in the workspace (skips node_modules, .git, dist)."); assert.deepEqual(c.parameters.required, ["path"]); assert.deepEqual(c.parameters.properties.mode.enum, ["a", "b"]); assert.equal(c.parameters.properties.path.description, undefined);
  assert.equal(compactSpec(spec, "Lists files.").description, "Lists files.");
  assert.equal(closestName("readfile", ["read_file", "grep", "sh"]), "read_file"); assert.equal(closestName("Read_Files", ["read_file", "grep"]), "read_file"); assert.equal(closestName("grepp", ["grep", "sh"]), "grep");
  assert.equal(closestName("fly_to_moon", ["read_file", "grep", "sh"]), undefined);
});

test("a call to an unknown tool is answered with the closest real name", async () => {
  const bad: Message = { role: "assistant", content: null, tool_calls: [{ id: "u1", function: { name: "readfile", arguments: '{"path":"a"}' } }] };
  const seen: Message[][] = []; const replies: Message[] = [bad, { role: "assistant", content: null, tool_calls: [{ id: "f", function: { name: "finish", arguments: '{"summary":"x"}' } }] }];
  const model: Model = async (msgs) => { seen.push(msgs.map((m) => ({ ...m }))); return replies.shift()!; };
  await createHarness({ model, tools: [read], stagnationTurns: 0 }).run("go");
  assert.match(seen[1].find((m) => m.role === "tool")!.content!, /unknown tool "readfile"\. Did you mean "read"\?/);
});

test("fit: kept thinking of older replies goes first, and the newest reply keeps its own", () => {
  const big = "t".repeat(40_000);
  const msgs: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "task" }, { role: "assistant", content: "a1", thinking: big }, { role: "user", content: "more" }, { role: "assistant", content: "a2", thinking: "recent thought" }];
  const r = fit(msgs, [], 2_000, 4);
  assert.ok(r.fits); assert.deepEqual(r.stages, ["old thinking"]); assert.equal(msgs[2].thinking, undefined); assert.equal(msgs[4].thinking, "recent thought");
});

// `amness doctor`: qualify a model before giving it a job. Models behind "OpenAI-compatible" endpoints differ in tool-call formatting,
// turn control and cache reuse (arXiv 2610.34241, abstract only); some stay schema-invalid even after corrective messages and should be kept
// out of tool roles (Mingbird, arXiv 2610.02001, read). The setup test call only checks that a model replies; this checks how it uses tools.
// A short scripted battery with scripted tools and no workspace access: a few thousand tokens.
import type { Message, Model, ModelOpts, ToolSpec } from "./harness.ts";
import { coerce, parseArgs, validate, type Schema } from "./schema.ts";
import { findTextCalls } from "./rescue.ts";
import type { Profile } from "./profiles.ts";

export type CheckResult = { id: string; title: string; pass: boolean; detail: string; ms?: number };
export type DoctorReport = {
  checks: CheckResult[];
  /** jobs this model can take, and the ones it cannot, with the reason */
  qualified: string[]; notFor: { role: string; why: string }[];
  /** what to put in the model's profile */
  suggest: Profile;
  /** measured: whether calls arrived as text, and the cold/warm latency ratio of a repeated prefix (1 = no prefix cache) */
  textCalls: boolean; cacheFactor?: number; tokens: number;
};

const RECORD: Schema = { type: "object", required: ["s", "n", "b", "list", "obj"], additionalProperties: false, properties: { s: { type: "string" }, n: { type: "integer" }, b: { type: "boolean" }, list: { type: "array", items: { type: "string" } }, obj: { type: "object", required: ["k"], properties: { k: { type: "string" } } } } };
const spec = (name: string, description: string, parameters: Schema): ToolSpec => ({ name, description, parameters: parameters as ToolSpec["parameters"] });
const T_RECORD = spec("probe_record", "Record a set of typed values.", RECORD);
const T_ECHO = spec("probe_echo", "Echo a number back.", { type: "object", required: ["x"], properties: { x: { type: "integer" } } });
const T_STEP = (k: number) => spec(`step_${k}`, `Step ${k} of a chain. Needs the token from the previous step.`, { type: "object", required: ["token"], properties: { token: { type: "string" } } });
const T_RANGE = spec("probe_range", "Store a number between 1 and 10.", { type: "object", required: ["n"], properties: { n: { type: "integer" } } });
// The schema shows only `value`; the scripted tool then says `unit` is missing. The right fix follows from the user's own words ("kilograms"),
// so a model that refuses instructions planted in tool results (as current models are trained to) still passes. See check 6.
const T_WEIGHT = spec("probe_weight", "Record a weight.", { type: "object", required: ["value"], properties: { value: { type: "number" } } });
const SYS = "You are being tested on tool use. Follow the instructions exactly. Use the tools when asked.";

type Call = { name: string; args: unknown; how: "native" | "text"; repaired: boolean };
/** The calls in a reply: native ones, else ones written as text. Arguments are parsed the way the harness would (argfix). */
function callsOf(m: Message, tools: ToolSpec[]): Call[] {
  const byName = new Map(tools.map((t) => [t.name, t.parameters as Schema]));
  const one = (name: string, raw: string, how: Call["how"]): Call | undefined => {
    const p = parseArgs(raw); if ("error" in p) return { name, args: undefined, how, repaired: false };
    const s = byName.get(name); let args: unknown = p.args, repaired = p.fixes.length > 0;
    if (s && validate(args, s).length) { const cz = coerce(args, s); if (!validate(cz.value, s).length) { args = cz.value; repaired = true; } }
    return { name, args, how, repaired };
  };
  const native = (m.tool_calls ?? []).map((c) => one(c.function.name, c.function.arguments, "native")).filter((c): c is Call => !!c);
  if (native.length) return native;
  return findTextCalls(m.content ?? "").map((c) => one(c.name, c.args, "text")).filter((c): c is Call => !!c);
}
const strictOk = (c: Call | undefined, s: Schema) => !!c && c.args !== undefined && validate(c.args, s).length === 0;

/**
 * Run the battery on `model`. `stated` is the window the server reports (from detectWindow), shown as is.
 * Each check is independent: a model that fails one still gets the others.
 */
export async function runDoctor(model: Model, o: { stated?: number; onCheck?: (c: CheckResult) => void; signal?: AbortSignal } = {}): Promise<DoctorReport> {
  const checks: CheckResult[] = []; let tokens = 0, textSeen = false, nativeSeen = false;
  const ask = async (msgs: Message[], tools: ToolSpec[], opts: ModelOpts = {}) => { const t0 = Date.now(); const m = await model(msgs, tools, { signal: o.signal, ...opts }); tokens += m.usage?.total_tokens ?? 0; return { m, ms: Date.now() - t0 }; };
  const add = (c: CheckResult) => { checks.push(c); o.onCheck?.(c); };
  const safely = async (id: string, title: string, f: () => Promise<Omit<CheckResult, "id" | "title">>) => { try { add({ id, title, ...(await f()) }); } catch (e) { add({ id, title, pass: false, detail: `error: ${(e as Error).message.slice(0, 160)}` }); } };

  // 1. One required call with typed arguments, up to three tries (with the error fed back, as the harness does).
  let typedTries = 0, typedOk = false;
  await safely("typed", "one tool call with typed arguments", async () => {
    const msgs: Message[] = [{ role: "system", content: SYS }, { role: "user", content: 'Call probe_record once with s = "amness", n = 42, b = true, list = ["a", "b"], obj = {"k": "v"}.' }];
    let last = "";
    for (typedTries = 1; typedTries <= 3; typedTries++) {
      const { m } = await ask(msgs, [T_RECORD]); const c = callsOf(m, [T_RECORD]).find((x) => x.name === "probe_record");
      if (c?.how === "text") textSeen = true; else if (c) nativeSeen = true;
      const a = c?.args as Record<string, unknown> | undefined;
      if (strictOk(c, RECORD) && a!.s === "amness" && a!.n === 42 && a!.b === true) { typedOk = true; return { pass: true, detail: `${c!.how === "text" ? "written as text" : "native call"}${c!.repaired ? ", needed argument repair" : ""}${typedTries > 1 ? `, on try ${typedTries}` : ""}` }; }
      last = !c ? "no call" : c.args === undefined ? "arguments are not JSON" : validate(c.args, RECORD).join("; ") || "wrong values";
      msgs.push(m, ...(m.tool_calls ?? []).map((t) => ({ role: "tool" as const, tool_call_id: t.id, content: `ERROR: ${last}. Call probe_record again with the exact values.` })));
      if (!m.tool_calls?.length) msgs.push({ role: "user", content: `That was not a valid call (${last}). Call probe_record with the exact values.` });
    }
    return { pass: false, detail: `failed 3 times (${last})` };
  });

  // 2. Two calls in one reply.
  await safely("parallel", "two tool calls in one reply", async () => {
    const { m } = await ask([{ role: "system", content: SYS }, { role: "user", content: "In ONE reply, call probe_echo twice: once with x = 1 and once with x = 2." }], [T_ECHO]);
    const xs = callsOf(m, [T_ECHO]).filter((c) => c.name === "probe_echo").map((c) => (c.args as { x?: unknown })?.x);
    return { pass: xs.includes(1) && xs.includes(2), detail: `${xs.length} call(s) in the reply` };
  });

  // 3. A chain of three, results fed back: does it follow the tokens, and does it stop when told?
  let chainOk = false;
  await safely("chain", "a chain of three calls, then stop", async () => {
    const tools = [T_STEP(1), T_STEP(2), T_STEP(3)], tok = ["start", "k7x", "q2m"];
    const msgs: Message[] = [{ role: "system", content: SYS }, { role: "user", content: 'Call step_1 with token "start". Each step tells you the next one. When a step says "done", answer with the single word DONE and call nothing.' }];
    for (let k = 1; k <= 4; k++) {
      const { m } = await ask(msgs, tools); const c = callsOf(m, tools)[0];
      if (k === 4) { const stopped = !c && /\bDONE\b/i.test(m.content ?? ""); chainOk = stopped; return { pass: stopped, detail: stopped ? "followed the chain and stopped" : c ? `kept calling (${c.name}) after "done"` : `stopped but said: ${(m.content ?? "").slice(0, 60)}` }; }
      if (!c || c.name !== `step_${k}` || (c.args as { token?: unknown })?.token !== tok[k - 1]) return { pass: false, detail: `step ${k}: ${c ? `called ${c.name} with ${JSON.stringify(c.args)}` : `no call (${(m.content ?? "").slice(0, 60)})`}` };
      const id = m.tool_calls?.[0]?.id ?? `t${k}`, result = k < 3 ? `ok. Next: call step_${k + 1} with token "${tok[k]}".` : "done.";
      msgs.push(m.tool_calls?.length ? m : { role: "assistant", content: null, tool_calls: [{ id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, { role: "tool", tool_call_id: id, content: result });
    }
    return { pass: false, detail: "unreachable" };
  });

  // 4. tool_choice "required": accepted by the server, and a valid call comes back even for a prompt that invites prose.
  await safely("required", 'tool_choice "required" gives a valid call', async () => {
    const { m } = await ask([{ role: "system", content: SYS }, { role: "user", content: "Say hello, then store the number 3." }], [T_RANGE], { toolChoice: "required" });
    const c = callsOf(m, [T_RANGE])[0];
    return { pass: !!c && c.how === "native" && strictOk(c, T_RANGE.parameters as Schema), detail: c ? `${c.how} call ${JSON.stringify(c.args)}` : "no call" };
  });

  // 5 is the native-or-text observation made in every check above.
  add({ id: "format", title: "calls arrive as structured tool_calls", pass: nativeSeen || !textSeen, detail: textSeen && !nativeSeen ? "calls came as text in the answer: turn on textToolCalls" : textSeen ? "mostly native, some as text" : nativeSeen ? "native" : "no call was seen" });

  // 6. Recovery: the first call fails with a harness-style argument error; is the next call corrected?
  // The fix must agree with what the user asked. An earlier version told the model to store a different number than the user's,
  // and careful models rightly refused to follow an instruction from a tool result (claude-sonnet-5-5 asked the user instead).
  let recoverOk = false;
  await safely("recover", "corrects a call after an error", async () => {
    const msgs: Message[] = [{ role: "system", content: SYS }, { role: "user", content: "Record a weight of 7 kilograms with probe_weight." }];
    const { m } = await ask(msgs, [T_WEIGHT]); const c = callsOf(m, [T_WEIGHT]).find((x) => x.name === "probe_weight");
    if (!c) return { pass: false, detail: "no first call" };
    const first = c.args as { value?: unknown; unit?: unknown } | undefined;
    if (first?.value === 7 && first.unit === "kg") { recoverOk = true; return { pass: true, detail: "sent the unit without being asked (no error to correct)" }; }
    const id = m.tool_calls?.[0]?.id ?? "r1";
    msgs.push(m.tool_calls?.length ? m : { role: "assistant", content: null, tool_calls: [{ id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] },
      { role: "tool", tool_call_id: id, content: 'ERROR: invalid arguments: missing required property "unit" (one of "kg", "lb"). Nothing was recorded.' });
    const r2 = await ask(msgs, [T_WEIGHT]), c2 = callsOf(r2.m, [T_WEIGHT]).find((x) => x.name === "probe_weight"), a2 = c2?.args as { value?: unknown; unit?: unknown } | undefined;
    recoverOk = a2?.value === 7 && a2.unit === "kg";
    return { pass: recoverOk, detail: c2 ? `second call ${JSON.stringify(c2.args)}` : `no second call (said: ${(r2.m.content ?? "").replace(/\s+/g, " ").slice(0, 80)})` };
  });

  // 7. Window: what the server states. Silent truncation is watched for during every session (see the harness).
  add({ id: "window", title: "context window stated by the server", pass: o.stated === undefined || o.stated >= 16_384, detail: o.stated === undefined ? "not stated (learned from the first overflow)" : `${o.stated} tokens${o.stated < 16_384 ? ": small, the small-window profile applies" : ""}${o.stated < 65_536 ? "; agents do better with 64k or more" : ""}` });

  // 8. Latency: a long prefix twice. A ratio well under 1 means the server reuses the prefix (its cache works).
  let cacheFactor: number | undefined;
  await safely("latency", "time to answer, cold and with the same prefix", async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `Fact ${i}: the value of item ${i} is ${(i * 7919) % 1000}.`).join("\n");
    const msgs: Message[] = [{ role: "system", content: `${SYS}\n${filler}` }, { role: "user", content: `Run ${Date.now()}: reply with OK only.` }];
    const a = await ask(msgs, [], { maxTokens: 16 }), b = await ask(msgs, [], { maxTokens: 16 });
    cacheFactor = a.ms >= 200 ? Math.round((b.ms / a.ms) * 100) / 100 : undefined;   // too fast to tell apart from noise below that
    return { pass: true, detail: `cold ${a.ms} ms, repeat ${b.ms} ms${cacheFactor !== undefined ? ` (×${cacheFactor})` : ""}`, ms: a.ms };
  });

  const toolsOk = typedOk, notFor: { role: string; why: string }[] = [], qualified = ["compact", "quarantine"];
  if (toolsOk && chainOk) qualified.push("explore", "review"); else notFor.push({ role: "explore", why: !toolsOk ? "no valid typed call in 3 tries" : "did not follow a three-step chain" }, { role: "review", why: !toolsOk ? "no valid typed call in 3 tries" : "did not follow a three-step chain" });
  if (toolsOk && chainOk && recoverOk) qualified.push("main", "edit"); else notFor.push({ role: "main", why: !toolsOk ? "no valid typed call in 3 tries" : !chainOk ? "did not follow a three-step chain" : "did not correct a call after an error" });
  if (!toolsOk) notFor.push({ role: "approve", why: "no valid typed call in 3 tries" }); else qualified.push("approve");
  const suggest: Profile = {};
  if (textSeen && !nativeSeen) suggest.textToolCalls = true;
  const req = checks.find((c) => c.id === "required");
  if (req?.pass && typedTries > 1) suggest.toolChoice = "required";
  if (!chainOk || !recoverOk) suggest.tier = "local";
  if (cacheFactor !== undefined && cacheFactor > 0 && cacheFactor < 1) suggest.cacheFactor = Math.max(0.01, cacheFactor);
  return { checks, qualified, notFor, suggest, textCalls: textSeen && !nativeSeen, cacheFactor, tokens };
}

/** A plain-text table of the report. */
export function formatDoctor(model: string, r: DoctorReport): string {
  const lines = [`amness doctor: ${model}`, ""];
  for (const c of r.checks) lines.push(`${c.pass ? "✓" : "✗"} ${c.title.padEnd(46)} ${c.detail}`);
  lines.push("", `qualified for: ${r.qualified.join(", ") || "nothing"}`);
  if (r.notFor.length) lines.push(`not for: ${r.notFor.map((x) => `${x.role} (${x.why})`).join("; ")}`);
  lines.push(Object.keys(r.suggest).length ? `suggested profile: ${JSON.stringify(r.suggest)}` : "suggested profile: nothing to change", `tokens used: ${r.tokens || "not reported"}`);
  return lines.join("\n");
}

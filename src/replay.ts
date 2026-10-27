// Replay a recorded trace through the CURRENT harness without calling any model or running any tool: the model's recorded messages and the tools' recorded results are fed back,
// so only the harness logic (guards, permissions, compaction, cache behaviour, hooks...) can differ. That makes harness changes testable offline, for free, on real sessions.
import { readFileSync } from "node:fs";
import { canonicalCall, createHarness, defineTool, type Event, type Message, type Model, type Options, type RunResult, type Tool } from "./harness.ts";
import { Tracer, type TraceLine } from "./trace.ts";

export type TraceRun = { messages: Message[]; models: Message[]; results: Map<string, string[]>; tools: string[]; lines: TraceLine[] };
const SIGNIFICANT = new Set(["nudge", "loop", "repair", "rejected", "denied", "hook", "trim", "cachebreak", "review", "audit", "finish", "aborted", "budget", "rollover", "tools", "steer"]);

/** Split a JSONL trace into runs (one per `run` event). Events of subagents are ignored: they are not regenerated. */
export function readTrace(file: string): TraceRun[] {
  const runs: TraceRun[] = []; let cur: TraceRun | undefined; const pending = new Map<string, { name: string; args: string }>();
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue; let e: TraceLine; try { e = JSON.parse(l); } catch { continue; }
    if (e.agent) continue;
    if (e.kind === "run") { cur = { messages: e.messages as Message[], models: [], results: new Map(), tools: [], lines: [] }; runs.push(cur); pending.clear(); continue; }
    if (!cur) continue;
    if (e.kind === "model") { cur.models.push(e.message as Message); continue; }
    if (e.kind === "toolstart") { pending.set(String(e.id), { name: String(e.name), args: String(e.args) }); continue; }
    if (e.kind === "tool") {
      const p = pending.get(String(e.id)); if (!p) continue; pending.delete(String(e.id)); if (!cur.tools.includes(p.name)) cur.tools.push(p.name);
      let args: unknown = {}; try { args = JSON.parse(p.args || "{}"); } catch { /* keep {} */ }
      const key = canonicalCall(p.name, args), list = cur.results.get(key) ?? []; list.push(String(e.result)); cur.results.set(key, list); continue;
    }
    if (SIGNIFICANT.has(e.kind)) cur.lines.push(e);
  }
  return runs;
}

const sig = (l: { kind: string; [k: string]: unknown }) => { const d = String(l.detail ?? l.summary ?? l.reason ?? "").replace(/\s+/g, " ").slice(0, 80); return `${l.kind}${d ? " · " + d : ""}`; };

export type ReplayReport = { run: number; turns: number; recorded: string[]; replayed: string[]; onlyRecorded: string[]; onlyReplayed: string[]; same: boolean; result: RunResult };

/** Feed one recorded run back through the harness with `o` as its options (the thing you changed). */
export async function replayRun(run: TraceRun, o: Partial<Options> = {}): Promise<ReplayReport> {
  const models = [...run.models], results = new Map([...run.results].map(([k, v]) => [k, [...v]]));
  const model: Model = async () => models.shift() ?? { role: "assistant", content: "(replay: the recorded trace ends here)" };
  const tools: Tool[] = run.tools.map((name) => defineTool({ name, description: "", schema: { type: "object" }, readOnly: true, run: (args: unknown) => results.get(canonicalCall(name, args))?.shift() ?? "ERROR: (replay) no recorded result for this call: the harness diverged from the recording here" }));
  const replayed: TraceLine[] = [], tracer = new Tracer({ sessionId: "replay", sink: (l) => replayed.push(l) });
  const result = await createHarness({ maxSteps: 60, approve: () => true, ...o, model, tools, onEvent: (e: Event) => tracer.event(e) }).run("", { resume: run.messages });
  const A = run.lines.map(sig), B = replayed.filter((l) => SIGNIFICANT.has(l.kind)).map(sig);
  const left = (xs: string[], ys: string[]) => { const c = new Map<string, number>(); for (const y of ys) c.set(y, (c.get(y) ?? 0) + 1); return xs.filter((x) => { const n = c.get(x) ?? 0; if (n > 0) { c.set(x, n - 1); return false; } return true; }); };
  const onlyRecorded = left(A, B), onlyReplayed = left(B, A);
  return { run: 0, turns: run.models.length, recorded: A, replayed: B, onlyRecorded, onlyReplayed, same: !onlyRecorded.length && !onlyReplayed.length, result };
}

export async function replayFile(file: string, o: Partial<Options> = {}): Promise<ReplayReport[]> {
  const runs = readTrace(file), out: ReplayReport[] = [];
  for (const [i, r] of runs.entries()) out.push({ ...(await replayRun(r, o)), run: i + 1 });
  return out;
}

export function formatReplay(reports: ReplayReport[]): string {
  if (!reports.length) return "no recorded runs in this trace (traces written before replay support, or with recording off, have no model messages)";
  const out: string[] = [];
  for (const r of reports) {
    out.push(`run ${r.run}: ${r.turns} model turn(s), ${r.same ? "identical harness behaviour" : `${r.onlyRecorded.length + r.onlyReplayed.length} difference(s)`}`);
    for (const s of r.onlyRecorded) out.push(`  - recorded only: ${s}`);
    for (const s of r.onlyReplayed) out.push(`  + replay only:   ${s}`);
    if (!r.same) out.push("  (after the first difference the recording no longer matches what the model would have said, so later lines are indicative)");
  }
  return out.join("\n");
}

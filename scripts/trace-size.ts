// How much bigger full recording makes a trace. Each recorded run in the given trace files is replayed through the harness twice (recorded model replies and
// tool results, so no model is called and nothing runs): once with normal recording, once with full recording. Prints the bytes of both and the ratio.
// Usage: node scripts/trace-size.ts .amness/traces/*.jsonl
import { Tracer, createHarness, readTrace, type TraceLine } from "../src/index.ts";
import { defineTool, canonicalCall, type Message, type Model, type Tool } from "../src/harness.ts";

type Row = { file: string; runs: number; requests: number; normal: number; full: number; raw: number; parts: Record<string, number> };
const rows: Row[] = [];
for (const file of process.argv.slice(2)) {
  let runs; try { runs = readTrace(file); } catch { continue; }
  const row: Row = { file, runs: 0, requests: 0, normal: 0, full: 0, raw: 0, parts: {} };
  for (const run of runs) {
    if (!run.models.length) continue;
    for (const full of [false, true]) {
      const models = [...run.models], results = new Map([...run.results].map(([k, v]) => [k, [...v]]));
      const model: Model = async () => models.shift() ?? { role: "assistant", content: "(end)" };
      const tools: Tool[] = run.tools.map((name) => defineTool({ name, description: "", schema: { type: "object" }, readOnly: true, run: (a: unknown) => results.get(canonicalCall(name, a))?.shift() ?? "ERROR: none" }));
      const lines: TraceLine[] = [], tr = new Tracer({ sessionId: "m", sink: (l) => lines.push(l), full: () => full });
      tr.event({ kind: "run", messages: run.messages } as never);
      await createHarness({ model, tools, maxSteps: 60, approve: () => true, onEvent: (e) => tr.event(e), onRequest: (r) => { tr.request(r); if (full) row.raw += JSON.stringify({ messages: r.messages, tools: r.tools }).length; }, record: true }).run("", { resume: run.messages as Message[] });
      await tr.close();
      const bytes = lines.reduce((n, l) => n + JSON.stringify(l).length + 1, 0);
      if (full) { row.full += bytes; row.requests += lines.filter((l) => l.kind === "request").length; for (const l of lines) if (["request", "blob", "thinking"].includes(l.kind)) row.parts[l.kind] = (row.parts[l.kind] ?? 0) + JSON.stringify(l).length + 1; }
      else row.normal += bytes;
    }
    row.runs++;
  }
  if (row.runs) rows.push(row);
}
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
let N = 0, F = 0, R = 0, W = 0;
for (const r of rows) { N += r.normal; F += r.full; R += r.requests; W += r.raw; console.log(`${r.file.split("/").pop()}  runs ${r.runs}  requests ${r.requests}  normal ${kb(r.normal)}  full ${kb(r.full)}  ×${(r.full / Math.max(1, r.normal)).toFixed(2)}  (${Object.entries(r.parts).map(([k, v]) => `${k} ${kb(v)}`).join(", ")})`); }
console.log(`\nwithout deduplication the requests alone would be ${kb(W)}; written: ${kb(rows.reduce((n, r) => n + (r.parts.request ?? 0) + (r.parts.blob ?? 0), 0))}`);
console.log(`${rows.length} traces · ${R} requests · normal ${kb(N)} · full ${kb(F)} · full is ×${(F / Math.max(1, N)).toFixed(2)} · ${kb((F - N) / Math.max(1, R))} more per request`);

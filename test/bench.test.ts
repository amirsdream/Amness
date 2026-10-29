import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, bench, commandLine, describePlan, formatReport, parseOutput, shellQuote, type Case, type Contestant } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "amness-bt-"));
const script = (dir: string, name: string, body: string) => { const f = join(dir, name); writeFileSync(f, body); return f; };
const task = (): Case => ({ name: "make-file", files: { "a.txt": "one\n" }, task: "Change a.txt to say two", verify: "node -e \"process.exit(require('fs').readFileSync('a.txt','utf8').trim()==='two'?0:1)\"", check: async (d) => (readFileSync(join(d, "a.txt"), "utf8").trim() === "two" ? true : "a.txt not changed") });

test("parsers read what each tool prints: Claude's JSON result, Amness's result line, and the common shapes of Codex events", () => {
  const claude = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 4200, num_turns: 3, result: "done", total_cost_usd: 0.0421, usage: { input_tokens: 120, cache_creation_input_tokens: 800, cache_read_input_tokens: 5000, output_tokens: 310 } });
  assert.deepEqual(parseOutput("claude-json", claude), { input: 5920, cached: 5000, output: 310, costUsd: 0.0421, turns: 3, text: "done", isError: false });
  assert.equal(parseOutput("claude-json", "[" + claude + "]").costUsd, 0.0421); assert.deepEqual(parseOutput("claude-json", "not json"), {});
  const amness = ['{"kind":"turn","step":0}', JSON.stringify({ kind: "result", finished: true, text: "ok", steps: 5, tokens: 9000 })].join("\n");
  assert.deepEqual(parseOutput("amness-json", amness), { input: 9000, output: undefined, turns: 5, text: "ok", isError: false });
  const cumulative = ['{"type":"thread.started"}', '{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}}', '{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":50}}}', '{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}'].join("\n");
  assert.deepEqual(parseOutput("codex-jsonl", cumulative), { input: 300, output: 50, cached: 200, text: "all done" });
  const perTurn = ['{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}', '{"type":"turn.completed","usage":{"input_tokens":150,"cached_input_tokens":100,"output_tokens":20}}'].join("\n");
  assert.deepEqual(parseOutput("codex-jsonl", perTurn), { input: 250, output: 30, cached: 100, text: undefined }); assert.deepEqual(parseOutput("none", "anything"), {});
});

test("presets and command lines: the prompt goes on stdin, placeholders are filled, nothing needs shell quoting", () => {
  const c = PRESETS["amness-gate"]({ model: "m1", amnessCli: "/x/amness.ts" }), line = commandLine(c, { task: "T", cwd: "/w", model: "m1", verify: "npm test" });
  assert.deepEqual(line.args.slice(-3), ["--verify", "npm test", "-"]); assert.ok(c.stdin && line.args.includes("m1"));
  assert.ok(PRESETS["claude-bare"]({}).args!.includes("--bare") && !PRESETS.claude({}).args!.includes("--bare")); assert.ok(PRESETS.codex({}).args!.includes("exec") && PRESETS.codex({}).args!.at(-1) === "-");
  assert.equal(shellQuote("plain-arg.1", true), "plain-arg.1"); assert.equal(shellQuote('has space "q"', true), '"has space \\"q\\""'); assert.equal(shellQuote("a b", false), "a b");
});

test("bench runs every contestant on every task in a fresh folder, grades them all with the same check, and records cost, tokens, time and notes", async () => {
  const d = tmp(), seenPrompts: string[] = [];
  const good = script(d, "good.mjs", `let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{ require("fs").writeFileSync("a.txt","two\\n"); console.log(JSON.stringify({type:"result",is_error:false,num_turns:2,result:"done",total_cost_usd:0.05,usage:{input_tokens:100,output_tokens:20}})); process.stderr.write(s.length>0?"got prompt":"no prompt"); });`.replace('require("fs")', 'process.getBuiltinModule("fs")').replace('require("fs")', 'process.getBuiltinModule("fs")'));
  const bad = script(d, "bad.mjs", `process.stdin.resume(); process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",num_turns:1,total_cost_usd:0.01,usage:{input_tokens:10,output_tokens:5}})));`);
  const slow = script(d, "slow.mjs", `setTimeout(()=>{}, 60000);`);
  const cfg = { trials: 2, jobs: 2, timeoutSec: 2, logDir: join(d, "logs"), contestants: [
    { name: "good", command: "node", args: [good], stdin: true, parse: "claude-json" }, { name: "bad", command: "node", args: [bad], stdin: true, parse: "claude-json" },
    { name: "slow", command: "node", args: [slow], stdin: true }, { name: "ghost", command: "definitely-not-a-real-program-xyz", args: [], stdin: true },
  ] as Contestant[] };
  const { rows, analysis } = await bench([task()], cfg);
  const by = (v: string) => rows.filter((r) => r.variant === v);
  assert.equal(rows.length, 8); assert.ok(by("good").every((r) => r.pass && r.metrics!["cost-usd"] === 0.05 && r.tokens === 120 && r.steps === 2)); assert.ok(by("bad").every((r) => !r.pass && r.note === "a.txt not changed" && r.tokens === 15));
  assert.ok(by("slow").every((r) => !r.pass && /timed out after 2s/.test(r.note!) && r.ms < 8000)); assert.ok(by("ghost").every((r) => !r.pass && /could not start|a\.txt not changed/.test(r.note!)));
  assert.equal(analysis.stats.find((s) => s.variant === "good")!.passRate, 1); assert.equal(analysis.stats.find((s) => s.variant === "good")!.metrics["cost-usd"], 0.05);
  assert.match(formatReport(analysis), /custom metrics[\s\S]*good\s+0\.05/);
  assert.ok(existsSync(join(d, "logs", "good", "make-file-0.out.txt")) && /"check": true/.test(readFileSync(join(d, "logs", "good", "make-file-0.cmd.json"), "utf8")));
  assert.match(readFileSync(join(d, "logs", "good", "make-file-0.err.txt"), "utf8"), /got prompt/);
  void seenPrompts;
});

test("describePlan shows the prompt and the exact command of each contestant without running anything", () => {
  const plan = describePlan([task()], { contestants: [PRESETS.claude({ model: "sonnet" })], trials: 3 }).join("\n");
  assert.match(plan, /1 task\(s\) × 1 contestant\(s\) × 3 trial\(s\) = 3 runs/); assert.match(plan, /Change a\.txt to say two\s+When you believe you are done, check your work by running: node -e/); assert.match(plan, /claude -p --output-format json .*--model sonnet\s+\(prompt on stdin\)/);
});

test("amness run - reads the task from standard input, so no shell quoting is needed (Windows friendly)", async () => {
  const replies = [{ role: "assistant", content: "done from stdin" }], seen: any[] = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (x) => (b += x)); req.on("end", () => { seen.push(JSON.parse(b)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: replies.shift() }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${(srv.address() as any).port}/v1`, d = tmp();
  const out = await new Promise<string>((res) => { const p = spawn("node", ["cli/amness.ts", "run", "--json", "--yes", "--cwd", d, "--no-memory", "-"], { env: { ...process.env, OPENAI_BASE_URL: url, OPENAI_API_KEY: "k", AMNESS_HOME: tmp(), AMNESS_MODEL: "m", AMNESS_PROVIDER: "custom" } }); let s = ""; p.stdout.on("data", (x) => (s += x)); p.on("close", () => res(s)); p.stdin.end('say "hi" to me (quotes and\nnewlines are fine)'); });
  srv.closeAllConnections(); srv.close();
  assert.match(JSON.stringify(seen[0]), /say \\"hi\\" to me \(quotes and\\nnewlines are fine\)/); assert.match(out, /"kind":"result"/); assert.match(out, /done from stdin/);
});

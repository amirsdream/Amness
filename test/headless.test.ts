import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Mock OpenAI-compatible server that replays scripted assistant messages. */
async function mockOpenAI(replies: object[]) {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.statusCode = 404; return void res.end("{}"); }   // the window probe (GET /models, /props) is not a model call
      seen.push(JSON.parse(b));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: replies.shift() }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, seen, close: () => srv.close() };
}
const tc = (id: string, name: string, args: object) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const cli = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((ok) => {
  const p = spawn("node", ["--no-warnings", "cli/amness.ts", ...args], { env: { ...process.env, AMNESS_HOME: mkdtempSync(join(tmpdir(), "amness-h-")), NO_COLOR: "1", ...env } });
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => ok({ code, out, err }));
});

test("amness run: full headless session over HTTP, JSONL events, live diff, bundle export, exit code 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-hl-")), bundle = join(dir, "out.json");
  const api = await mockOpenAI([tc("1", "write_file", { path: "hello.js", content: "console.log('hi');\n" }), tc("2", "sh", { cmd: "node hello.js" }), tc("3", "finish", { summary: "created hello.js" }),
    { role: "assistant", content: "GOAL: hello\nDONE: wrote hello.js\nNEXT: nothing" }]);
  try {
    const r = await cli(["run", "--provider", "custom", "--base-url", api.url, "--model", "m", "--cwd", dir, "--verify", "node hello.js", "--json", "--export", bundle, "--max-tokens", "100000", "make hello"]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
    const edit = lines.find((l) => l.kind === "edit");
    assert.deepEqual([edit.path, edit.created, edit.added], ["hello.js", true, 1]);
    const { usage, cost, ...rest } = lines.at(-1);
    assert.deepEqual(rest, { kind: "result", finished: true, text: "created hello.js", steps: 3, tokens: 240, model: "m" });
    assert.deepEqual([usage.prompt, usage.completion, usage.cached, usage.requests], [150, 30, 0, 3]); assert.equal(cost, null);   // what benchmarks read (the unknown model "m" has no price)
    assert.equal(existsSync(join(dir, "hello.js")), true);
    assert.equal(JSON.parse(readFileSync(bundle, "utf8")).files["hello.js"], "console.log('hi');\n");
    assert.match(JSON.parse(readFileSync(bundle, "utf8")).handoff, /DONE: wrote hello.js/);
    assert.equal(api.seen[0].model, "m"); assert.ok(api.seen[0].tools.some((t: any) => t.function.name === "memory_save"));
  } finally { api.close(); }
});

test("amness run: risky command denied without --yes (model sees why); usage errors exit 2; unfinished exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-hl-"));
  const api = await mockOpenAI([tc("1", "sh", { cmd: "rm -rf /tmp/amness-nothing" }), { role: "assistant", content: "Cannot proceed.", tool_calls: undefined }]);
  try {
    const r = await cli(["run", "--provider", "custom", "--base-url", api.url, "--cwd", dir, "--json", "delete things"]);
    assert.equal(r.code, 1);
    assert.match(JSON.stringify(api.seen[1].messages), /non-interactive run: risky commands are denied/);
  } finally { api.close(); }
  assert.equal((await cli(["run"])).code, 2);
  assert.equal((await cli(["run", "--provider", "nope", "x"])).code, 2);
  const noKey = await cli(["run", "--provider", "anthropic", "x"], { ANTHROPIC_API_KEY: "" });
  assert.equal(noKey.code, 2); assert.match(noKey.err, /ANTHROPIC_API_KEY/);
});

test("amness run --help prints usage and exits 0 without calling any model", async () => {
  const srv = await mockOpenAI([]); const out: string[] = [];
  const code = await new Promise<number>((res) => { const p = spawn("node", ["cli/amness.ts", "run", "--help"], { env: { ...process.env, OPENAI_BASE_URL: srv.url, OPENAI_API_KEY: "k" } }); p.stdout.on("data", (d) => out.push(String(d))); p.on("close", (c) => res(c ?? 1)); });
  srv.close(); assert.equal(code, 0); assert.match(out.join(""), /usage: amness run/); assert.equal(srv.seen.length, 0);
});

test("amness run: --plugin loads a plugin file for this run (its tool is offered), --off switches guards off, and an unknown guard is a usage error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-pl-")), plugin = join(dir, "p.mjs");
  writeFileSync(plugin, `export default { name: "bench-probe", tools: [{ name: "probe_tool", description: "probe", schema: { type: "object", properties: {} }, run: () => "ok" }] };`);
  const api = await mockOpenAI([tc("1", "finish", { summary: "done" })]);
  try {
    const r = await cli(["run", "--provider", "custom", "--base-url", api.url, "--model", "m", "--cwd", dir, "--json", "--plugin", plugin, "--off", "nudge,compact", "go"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(api.seen[0].tools.some((t: any) => t.function.name === "probe_tool"));
    const cfg = JSON.parse(r.out.split("\n")[0]);                                                         // the first line says what is in effect
    assert.equal(cfg.kind, "config"); assert.match(cfg.version, /^\d+\.\d+\.\d+/); assert.deepEqual(cfg.guardsOff, ["nudge", "compact"]);
    assert.ok(cfg.guardsOn.includes("loop") && !cfg.guardsOn.includes("nudge")); assert.deepEqual(cfg.plugins, ["bench-probe"]); assert.equal(cfg.maxSteps, 40); assert.equal(cfg.toolChoice, "auto");
    const bad = await cli(["run", "--provider", "custom", "--base-url", api.url, "--model", "m", "--cwd", dir, "--off", "nosuch", "go"]);
    assert.equal(bad.code, 2); assert.match(bad.err, /unknown guard nosuch/);
  } finally { api.close(); }
});

test("amness run: --max-time tells the agent to wrap up near the end, then stops cleanly and still writes the result line (stopped: time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-mt-")), seen: any[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      if (req.method !== "POST") { res.statusCode = 404; return void res.end("{}"); }
      seen.push(JSON.parse(b));
      setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: tc(String(seen.length), "list_files", { path: "." + "/".repeat(seen.length % 3) }) }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })); }, 400);   // a slow model that never finishes
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const t0 = Date.now(), r = await cli(["run", "--provider", "custom", "--base-url", `http://127.0.0.1:${(srv.address() as any).port}/v1`, "--model", "m", "--cwd", dir, "--json", "--max-time", "3", "--off", "loop", "go"]);
    const last = JSON.parse(r.out.trim().split("\n").at(-1)!);
    assert.equal(last.kind, "result"); assert.equal(last.stopped, "time"); assert.ok(last.usage.requests >= 2);
    assert.ok(Date.now() - t0 < 9000, "it stopped near the limit");
    assert.ok(seen.some((x) => x.messages.some((m: any) => m.role === "user" && /Time is almost up/.test(m.content ?? ""))), "the wrap-up note reached the model");
  } finally { srv.close(); }
});

test("amness run: tool choice comes from --tool-choice or the model's profile and reaches the server as tool_choice; profiles accept every guard name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-tc-")), home = mkdtempSync(join(tmpdir(), "amness-h-"));
  const run = async (args: string[], env: Record<string, string> = {}) => { const api = await mockOpenAI([tc("1", "finish", { summary: "done" })]);
    try { const r = await cli(["run", "--provider", "custom", "--base-url", api.url, "--model", "qwen-local", "--cwd", dir, "--json", ...args, "go"], env); return { r, body: api.seen[0] }; } finally { api.close(); } };
  let { r, body } = await run(["--tool-choice", "required"]);
  assert.equal(r.code, 0, r.err); assert.equal(body.tool_choice, "required");
  ({ body } = await run([])); assert.equal(body.tool_choice, undefined);                // nothing set: the server decides
  writeFileSync(join(home, "profile.json"), JSON.stringify({ models: { "qwen-*": { toolChoice: "required", off: ["anchor", "audit", "pin"] } } }));
  ({ r, body } = await run([], { AMNESS_HOME: home })); assert.equal(r.code, 0, r.err); assert.equal(body.tool_choice, "required");
  const bad = await cli(["run", "--provider", "custom", "--base-url", "http://127.0.0.1:9/v1", "--model", "m", "--cwd", dir, "--tool-choice", "always", "go"]);
  assert.equal(bad.code, 2); assert.match(bad.err, /--tool-choice must be auto or required/);
});

test("amness run: options never leak into the task text, wherever they are read (the agent once got '--trace --max-time -' as its task)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-args-")), trace = join(dir, "t.jsonl");
  const api = await mockOpenAI([tc("1", "finish", { summary: "done" })]);
  try {
    const r = await cli(["run", "--provider", "custom", "--base-url", api.url, "--model", "m", "--cwd", dir, "--json", "--yes", "--no-memory", "--trace", trace, "--max-time", "600", "--off", "nudge",
      "--tool-choice", "auto", "--max-steps", "9", "--plans", "--quarantine", "fix", "the", "bug", "--context-window", "32768"]);
    assert.equal(r.code, 0, r.err);
    const user = api.seen[0].messages.find((m: any) => m.role === "user").content as string;
    assert.match(user, /^fix the bug(\n|$)/); assert.doesNotMatch(user.split("\n")[0], /--|600|32768|nudge/);
  } finally { api.close(); }
  const viaStdin = await mockOpenAI([tc("1", "finish", { summary: "done" })]);
  try {
    const p = spawn("node", ["--no-warnings", "cli/amness.ts", "run", "--provider", "custom", "--base-url", viaStdin.url, "--model", "m", "--cwd", dir, "--json", "--trace", trace, "--max-time", "600", "-"], { env: { ...process.env, AMNESS_HOME: mkdtempSync(join(tmpdir(), "amness-h-")) } });
    p.stdin.end("the task from stdin"); await new Promise((ok) => p.on("close", ok));
    assert.match(viaStdin.seen[0].messages.find((m: any) => m.role === "user").content, /^the task from stdin/);   // the Harbor adapter's shape: options, then "-"
  } finally { viaStdin.close(); }
});

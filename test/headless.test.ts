import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Mock OpenAI-compatible server that replays scripted assistant messages. */
async function mockOpenAI(replies: object[]) {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
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
    assert.deepEqual(lines.at(-1), { kind: "result", finished: true, text: "created hello.js", steps: 3, tokens: 240 });
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

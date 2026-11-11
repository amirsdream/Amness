import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, wireModels } from "../cli/roles.ts";
import type { Config } from "../cli/config.ts";
import type { Model } from "../src/index.ts";

const base: Config = { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", apiKey: "sk-main", maxTokens: 1000,
  servers: [{ name: "lab", provider: "custom", baseUrl: "http://10.0.0.5:8000/v1", model: "qwen-35b" }] };

test("resolveConfig: each reference form reaches its own provider, address and model", () => {
  const r = (ref: string) => { const x = resolveConfig(ref, base); return [x.config.provider, x.config.baseUrl, x.config.model, x.config.server ?? null, x.label]; };
  assert.deepEqual(r("claude-haiku-5-5"), ["anthropic", "https://api.anthropic.com", "claude-haiku-5-5", null, "claude-haiku-5-5"]);
  assert.deepEqual(r("anthropic:claude-haiku-5-5"), ["anthropic", "https://api.anthropic.com", "claude-haiku-5-5", null, "anthropic:claude-haiku-5-5"]);
  assert.deepEqual(r("openai:gpt-6-luna"), ["openai", "https://api.openai.com/v1", "gpt-6-luna", null, "openai:gpt-6-luna"]);
  assert.deepEqual(r("openai/gpt-6-luna"), ["openai", "https://api.openai.com/v1", "gpt-6-luna", null, "openai:gpt-6-luna"]);
  assert.deepEqual(r("server:lab"), ["custom", "http://10.0.0.5:8000/v1", "qwen-35b", "lab", "server:lab/qwen-35b"]);
  assert.deepEqual(r("server:lab/qwen-4b"), ["custom", "http://10.0.0.5:8000/v1", "qwen-4b", "lab", "server:lab/qwen-4b"]);
  assert.deepEqual(r("lab"), ["custom", "http://10.0.0.5:8000/v1", "qwen-35b", "lab", "server:lab/qwen-35b"]);
  assert.deepEqual(r("mistral:latest"), ["anthropic", "https://api.anthropic.com", "mistral:latest", null, "mistral:latest"]);   // an Ollama-style tag is a bare id
  assert.throws(() => resolveConfig("server:nope", base), /no saved server named "nope".*server:lab/);
});

test("resolveConfig: a role on a saved server never carries the main provider's key", () => {
  const x = resolveConfig("server:lab", base).config;
  assert.notEqual(x.apiKey, "sk-main");
  const o = resolveConfig("openai:gpt-6-luna", base).config;
  assert.notEqual(o.apiKey, "sk-main");
  assert.equal(resolveConfig("claude-haiku-5-5", base).config.apiKey, "sk-main");                // same provider: same key
});

test("openrouter: a provider/model id is an OpenRouter model, not another provider", () => {
  const or: Config = { ...base, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1" };
  const x = resolveConfig("anthropic/claude-haiku-5-5", or);
  assert.equal(x.config.provider, "openrouter"); assert.equal(x.config.model, "anthropic/claude-haiku-5-5");
  assert.equal(resolveConfig("anthropic:claude-haiku-5-5", or).config.provider, "anthropic");    // the colon form still switches
});

test("wireModels: roles get their own models, labels name them, same-as-main roles are left out", () => {
  const made: Config[] = [];
  const main: Model = async () => ({ role: "assistant", content: "main" });
  const make = (c: Config): Model => { made.push(c); return async () => ({ role: "assistant", content: c.model }); };
  const w = wireModels({ ...base, models: { explore: "server:lab", review: "claude-opus-5-5", compact: "anthropic:claude-haiku-5-5", approve: "server:lab" } }, main, make);
  assert.ok(w.roles.explore && w.roles.compact); assert.equal(w.roles.review, undefined);
  assert.deepEqual(w.labels, { explore: "server:lab/qwen-35b", compact: "anthropic:claude-haiku-5-5", approve: "server:lab/qwen-35b" });
  assert.equal(made.length, 2);                                                                      // explore and approve share one model
  assert.equal(w.approve, w.roles.explore);
  assert.equal(w.byRef("claude-opus-5-5"), main);
});

async function mock(replies: object[], tag: string) {
  const seen: any[] = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.statusCode = 404; return void res.end("{}"); }
    seen.push(JSON.parse(b)); res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: replies.shift() ?? { role: "assistant", content: `${tag} has nothing more` } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, seen, close: () => srv.close() };
}
const tc = (id: string, name: string, args: object) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("amness run --explore-model server:<name>: exploration runs on the saved server, and the config line names the role", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-roles-")), home = mkdtempSync(join(tmpdir(), "amness-h-"));
  const lab = await mock([tc("e1", "finish", { summary: "the answer is in a.txt" })], "lab");
  const main = await mock([tc("1", "task", { description: "find where the answer is" }), tc("2", "finish", { summary: "found it" })], "main");
  writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseUrl: main.url, model: "big", maxTokens: 100000, servers: [{ name: "lab", provider: "custom", baseUrl: lab.url, model: "small" }] }));
  try {
    const r = await new Promise<{ code: number | null; out: string; err: string }>((ok) => {
      const p = spawn("node", ["--no-warnings", "cli/amness.ts", "run", "--cwd", dir, "--json", "--explore-model", "server:lab", "--max-tokens", "100000", "where is the answer"], { env: { ...process.env, AMNESS_HOME: home, NO_COLOR: "1" } });
      let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => ok({ code, out, err }));
    });
    assert.equal(r.code, 0, r.err + r.out);
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines[0].roles, { explore: "server:lab/small" });
    assert.deepEqual(lines[0].harnessCard.execution.roles, { explore: "server:lab/small" }); assert.equal(lines[0].harnessCard.tools.subagents, true); assert.equal(lines[0].tier, "local");
    assert.equal(lab.seen.length, 1, r.out.slice(0, 3000)); assert.equal(lab.seen[0].model, "small");
    assert.ok(main.seen.every((b) => b.model === "big"));
    const bad = await new Promise<number | null>((ok) => { const p = spawn("node", ["--no-warnings", "cli/amness.ts", "run", "--cwd", dir, "--explore-model", "server:nope", "x"], { env: { ...process.env, AMNESS_HOME: home } }); p.on("close", ok); });
    assert.equal(bad, 2);
  } finally { lab.close(); main.close(); }
});

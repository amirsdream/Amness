import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { argOptions } from "../cli/tui/argcomplete.ts";
import { renderBlock, type RenderCtx } from "../cli/tui/cards.ts";
import { tokenAtCursor } from "../cli/tui/complete.ts";
import { clearModelCache, fetchModels } from "../cli/models.ts";
import { getTheme } from "../cli/tui/themes.ts";
import type { Block } from "../cli/tui/blocks.ts";
import type { App } from "../cli/tui/app.ts";

test("tokenAtCursor: the words after a command are completed, one at a time", () => {
  const t = (s: string) => tokenAtCursor(s, s.length);
  assert.deepEqual(t("/mod"), { kind: "slash", query: "mod", start: 0, end: 4 });          // still choosing the command
  assert.deepEqual(t("/mode "), { kind: "arg", cmd: "mode", words: [], query: "", start: 6, end: 6 });
  assert.deepEqual(t("/mode ya"), { kind: "arg", cmd: "mode", words: [], query: "ya", start: 6, end: 8 });
  assert.deepEqual(t("/models explore gp"), { kind: "arg", cmd: "models", words: ["explore"], query: "gp", start: 16, end: 18 });
  assert.equal(t("hello /mode ")?.kind, undefined);                                         // only a command at the start of the input
});

const fakeApp = (over: Record<string, unknown> = {}) => ({ cfg: { provider: "anthropic", model: "claude-opus-5-5", baseUrl: "http://127.0.0.1:1", apiKey: undefined }, cwd: process.cwd(), session: { turns: [{ text: "first task" }, { text: "second task" }] }, ...over }) as unknown as App;

test("argument options: modes, themes, sandbox, on/off, turns", () => {
  const a = fakeApp(), vals = (cmd: string, words: string[] = []) => argOptions(a, cmd, words).options.map((o) => o.value);
  assert.deepEqual(vals("mode"), ["default", "acceptEdits", "plan", "yolo"]);
  assert.deepEqual(vals("sandbox"), ["off", "workspace", "strict"]);
  assert.deepEqual(vals("keepwarm"), ["on", "off"]);
  assert.ok(vals("theme").length > 1);
  assert.deepEqual(vals("effort").slice(0, 3), ["default", "low", "medium"]);               // Claude levels
  assert.deepEqual(vals("branch"), ["1", "2"]);
  assert.deepEqual(vals("mode", ["plan"]), []);                                             // nothing to complete after the value
  assert.deepEqual(vals("nonsense"), []);
  assert.equal(argOptions(a, "memory", []).options.find((o) => o.value === "add")?.more, true);   // `/memory add <text>` needs more words
});

test("fetchModels: OpenAI-style and Anthropic-style endpoints, failures give an empty list", async () => {
  const seen: Record<string, string | undefined>[] = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"] as string | undefined, ver: req.headers["anthropic-version"] as string | undefined });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models/models") { res.statusCode = 500; return void res.end("{}"); }
    res.end(JSON.stringify({ data: [{ id: "zeta-1" }, { id: "alpha-2" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "alpha-2" }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    clearModelCache();
    assert.deepEqual(await fetchModels({ provider: "openai", baseUrl: base + "/v1", apiKey: "sk-x" }), ["alpha-2", "zeta-1"]);   // sorted, de-duplicated, embeddings and audio dropped
    assert.equal(seen[0].url, "/v1/models"); assert.equal(seen[0].auth, "Bearer sk-x");
    assert.deepEqual(await fetchModels({ provider: "anthropic", baseUrl: base, apiKey: "sk-ant-x" }), ["alpha-2", "zeta-1"]);
    assert.equal(seen[1].url, "/v1/models?limit=100"); assert.equal(seen[1].xkey, "sk-ant-x"); assert.equal(seen[1].ver, "2023-06-01");
    const n = seen.length; await fetchModels({ provider: "openai", baseUrl: base + "/v1", apiKey: "sk-x" }); assert.equal(seen.length, n, "second call is served from the cache");
    assert.deepEqual(await fetchModels({ provider: "openai", baseUrl: base + "/v1/models", apiKey: "k" }), []);                // a 500 gives []
  } finally { srv.close(); }
  assert.deepEqual(await fetchModels({ provider: "openai", baseUrl: "http://127.0.0.1:1/v1" }), []);                          // nothing listening gives []
});

test("the most recent tool call keeps its output open (a short preview); older ones stay collapsed; the rest is behind /output", () => {
  const ctx = (last: boolean): RenderCtx => ({ theme: getTheme("dark"), width: 100, now: 0, frame: 0, expandAll: false, live: false, brand: { icon: "●", color: 0 }, diffMode: "auto", last });
  const out = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const sh: Block = { id: 1, kind: "tool", callId: "c1", name: "sh", args: JSON.stringify({ cmd: "npm test" }), status: "ok", result: `exit=0\n${out}`, t0: 0 };
  const text = (r: ReturnType<typeof renderBlock>) => r.text.join("\n");
  const last = text(renderBlock(sh, ctx(true))), old = text(renderBlock(sh, ctx(false)));
  assert.ok(last.includes("$ npm test") && last.includes("line 1") && last.includes("line 20"));
  assert.ok(!last.includes("line 21") && last.includes("20 more lines") && last.includes("/output"));
  assert.ok(!old.includes("line 1\n") && !old.includes("$ npm test"));                      // an older call is one collapsed line
  const clicked: Block = { ...sh, expanded: false };
  assert.ok(!text(renderBlock(clicked, ctx(true))).includes("line 1\n"));                   // the user closed it: it stays closed
  const read: Block = { ...sh, id: 2, name: "read_file", args: JSON.stringify({ path: "a.ts" }), result: "1\tconst a = 1;" };
  assert.ok(!text(renderBlock(read, ctx(true))).includes("const a"));                       // a lone file read does not open itself
});

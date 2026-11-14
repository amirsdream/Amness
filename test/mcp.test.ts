import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { connectMcp, floorCheck, headerValue, mcpParamHeaders, McpHub, projectConfigFingerprint } from "../src/index.ts";
import { fakeHttpMcp } from "./helpers/fake-mcp-http.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "amness-mcp-"));
process.env.AMNESS_HOME = tmp();
const { acpEntries, addServer, cliEntries, expandVars, mcpEntries, removeServer, setDisabled } = await import("../cli/mcpconfig.ts");

test("Streamable HTTP 2026-07-28: discover, the required headers (version, method, name, x-mcp-header params), JSON and SSE answers", async () => {
  for (const stream of [false, true]) {
    const s = await fakeHttpMcp({ mode: "modern", stream });
    const warns: string[] = [];
    try {
      const h = await connectMcp({ type: "http", url: s.url }, { name: "web", warn: (w) => warns.push(w) });
      assert.equal(h.era, "modern"); assert.equal(h.transport, "http"); assert.equal(h.server.name, "fake-http");
      assert.deepEqual(h.tools.map((t) => t.name), ["web__echo", "web__wipe"]);                       // the tool with an invalid x-mcp-header is dropped, with a warning
      assert.match(warns.join("\n"), /bad_header dropped/);
      const echo = h.tools.find((t) => t.name === "web__echo")!;
      assert.equal(await echo.run({ text: "hi", region: "eu-west" }, {} as any), "echo:hi@eu-west");   // the fake rejects the call if Mcp-Param-Region is missing or differs
      assert.equal(await echo.run({ text: "hé" }, {} as any), "echo:hé");
      await assert.rejects(Promise.resolve(h.tools.find((t) => t.name === "web__wipe")!.run({}, {} as any)), /nope/);   // isError reaches the model as a failed call
      assert.ok(s.seen.every((r) => !r.headers["mcp-session-id"]));
      h.close();
    } finally { await s.close(); }
  }
});

test("legacy Streamable HTTP (session id) and the old HTTP+SSE transport still work", async () => {
  const l = await fakeHttpMcp({ mode: "legacy" });
  try {
    const h = await connectMcp({ url: l.url }, { name: "old" });
    assert.equal(h.era, "legacy"); assert.equal(await h.tools[0].run({ text: "a" }, {} as any), "echo:a");
    assert.ok(l.seen.some((r) => r.headers["mcp-session-id"] === "s1"));
    h.close();
  } finally { await l.close(); }
  const e = await fakeHttpMcp({ mode: "sse" });
  try {
    const h = await connectMcp({ type: "sse", url: e.url }, { name: "older" });
    assert.equal(h.era, "sse"); assert.equal(h.transport, "sse"); assert.equal(await h.tools[0].run({ text: "b" }, {} as any), "echo:b");
    h.close();
  } finally { await e.close(); }
});

test("auth: a 401 is reported as needing sign-in; static headers and a headersHelper supply the token", async () => {
  const s = await fakeHttpMcp({ mode: "modern", auth: "t0k" });
  try {
    const hub = new McpHub(); await hub.start([{ name: "locked", scope: "user", config: { type: "http", url: s.url } }]);
    const row = hub.rows()[0]; assert.equal(row.status, "needs-login"); assert.match(row.error!, /amness mcp login locked/); hub.close();
    const a = await connectMcp({ type: "http", url: s.url, headers: { Authorization: "Bearer t0k" } }, { name: "h" }); assert.equal(a.tools.length, 2); a.close();
    const b = await connectMcp({ type: "http", url: s.url, headersHelper: `node -e "console.log(JSON.stringify({Authorization:'Bearer t0k'}))"` }, { name: "hh" }); assert.equal(b.tools.length, 2); b.close();
  } finally { await s.close(); }
});

test("x-mcp-header rules and header value encoding", () => {
  assert.deepEqual(mcpParamHeaders({ type: "object", properties: { a: { type: "string", "x-mcp-header": "A" }, o: { type: "object", properties: { b: { type: "integer", "x-mcp-header": "B" } } } } }), [{ name: "A", path: ["a"] }, { name: "B", path: ["o", "b"] }]);
  assert.throws(() => mcpParamHeaders({ properties: { n: { type: "number", "x-mcp-header": "N" } } }), /number/);
  assert.throws(() => mcpParamHeaders({ properties: { l: { type: "array", items: { type: "string", "x-mcp-header": "L" } } } }), /reachable/);
  assert.throws(() => mcpParamHeaders({ properties: { a: { type: "string", "x-mcp-header": "X" }, b: { type: "string", "x-mcp-header": "x" } } }), /twice/);
  assert.equal(headerValue("us-west1"), "us-west1");
  assert.equal(headerValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
  assert.equal(headerValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
});

test("config: local beats .mcp.json beats yours; .mcp.json waits for trust; ${VAR} expansion keeps provider keys away from remote servers", () => {
  const d = tmp(); spawnSync("git", ["init", "-q"], { cwd: d });
  writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node", args: ["x.js"] }, both: { url: "https://team.example/mcp" } } }));
  addServer("local", d, "both", { command: "node", args: ["mine.js"] });
  addServer("user", d, "mine", { type: "http", url: "https://${HOST:-api.example}/mcp", headers: { Authorization: "Bearer ${OPENAI_API_KEY}", X: "${NOPE}" } });
  assert.match(readFileSync(join(d, ".git", "info", "exclude"), "utf8"), /\.amness\/settings\.local\.json/);
  process.env.OPENAI_API_KEY = "sk-secret";
  const r = mcpEntries(d, { trusted: false });
  const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(by.both.scope, "local"); assert.equal(by.both.config.command, "node");                     // the higher layer wins as a whole
  assert.equal(by.shared.pending, true); assert.equal(mcpEntries(d, { trusted: true }).entries.find((e) => e.name === "shared")!.pending, false);
  assert.equal(by.mine.config.url, "https://api.example/mcp");
  assert.equal(by.mine.config.headers!.Authorization, "Bearer ");                                         // a provider key never goes to a remote server
  assert.match(r.notes.join("\n"), /\$\{NOPE\} not set/);
  setDisabled(d, "mine", true); assert.equal(mcpEntries(d, { trusted: false }).entries.find((e) => e.name === "mine")!.disabled, true); setDisabled(d, "mine", false);
  assert.equal(removeServer(d, "both"), "local"); assert.equal(mcpEntries(d, { trusted: false }).entries.find((e) => e.name === "both")!.scope, "project");
  assert.equal(expandVars("${A:-x}-${B}", { B: "b" }), "x-b");
  delete process.env.OPENAI_API_KEY;
});

test("a cloned repo's .mcp.json is part of the trust fingerprint, and the agent may not write it", () => {
  const d = tmp(); assert.equal(projectConfigFingerprint(d), undefined);
  writeFileSync(join(d, ".mcp.json"), "{}"); const a = projectConfigFingerprint(d); assert.ok(a);
  writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { x: { command: "evil" } } })); assert.notEqual(projectConfigFingerprint(d), a);
  assert.equal(floorCheck("write_file", { path: ".mcp.json" }, d).action, "deny");
  assert.equal(floorCheck("sh", { cmd: "echo '{}' > .mcp.json" }, d).action, "deny");
  assert.equal(floorCheck("sh", { cmd: "cat .mcp.json" }, d).action, "none");
});

test("--mcp-config files and inline JSON; ACP's server list (stdio env pairs, http headers)", () => {
  const d = tmp(); mkdirSync(join(d, "c")); writeFileSync(join(d, "c", "m.json"), JSON.stringify({ mcpServers: { a: { command: "node" } } }));
  assert.deepEqual(cliEntries(["c/m.json", '{"mcpServers":{"b":{"url":"https://b.example/mcp"}}}'], d).map((e) => [e.name, e.scope]), [["a", "cli"], ["b", "cli"]]);
  const acp = acpEntries([{ name: "fs", command: "npx", args: ["-y", "srv"], env: [{ name: "K", value: "v" }] }, { type: "http", name: "gh", url: "https://gh.example/mcp", headers: [{ name: "Authorization", value: "Bearer z" }] }, { bogus: 1 }]);
  assert.deepEqual(acp.map((e) => e.config), [{ command: "npx", args: ["-y", "srv"], env: { K: "v" } }, { type: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer z" } }]);
});

test("the hub connects configured servers in parallel, reports each status, and gives their tools", async () => {
  const s = await fakeHttpMcp({ mode: "modern" }); const hub = new McpHub({ cwd: process.cwd() });
  try {
    await hub.start([
      { name: "remote", scope: "user", config: { type: "http", url: s.url } },
      { name: "local", scope: "local", config: { command: "node", args: ["test/fake-mcp.mjs"], env: { MODE: "modern" } } },
      { name: "off", scope: "user", config: { command: "node" }, disabled: true },
      { name: "wait", scope: "project", config: { command: "node" }, pending: true },
      { name: "broken", scope: "user", config: { command: "node", args: ["-e", "process.exit(3)"] } },
    ]);
    const st = Object.fromEntries(hub.rows().map((r) => [r.name, r.status]));
    assert.deepEqual(st, { remote: "connected", local: "connected", off: "disabled", wait: "pending", broken: "failed" });
    assert.ok(hub.tools().some((t) => t.name === "remote__echo") && hub.tools().some((t) => t.name === "local__echo"));
    await hub.start([{ name: "remote", scope: "user", config: { type: "http", url: s.url } }]);            // a server no longer listed is closed
    assert.deepEqual(hub.rows().map((r) => r.name), ["remote"]);
  } finally { hub.close(); await s.close(); }
});

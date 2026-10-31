import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Each case runs in a child process, because the key store is chosen from environment variables when the module loads.
const KEY = "sk-test-0123456789abcdefghij";
const child = (home: string, code: string, env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as c from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../cli/config.ts")).href)}; ${code}`], {
    encoding: "utf8", env: { ...(process.platform === "win32" ? process.env : { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }), AMNESS_HOME: home, ...env }, // Windows tools need the user-profile variables
  });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const fresh = () => mkdtempSync(join(tmpdir(), "amness-ks-"));

test("file backend: the key file is owner-only and an environment key is never written to it", { skip: process.platform === "win32" }, () => {
  const home = fresh();
  child(home, `const x = c.loadConfig(); x.apiKey = ${JSON.stringify(KEY)}; c.saveConfig(x);`, { AMNESS_KEYSTORE: "file" });
  const f = join(home, "config.json");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).apiKeys.openai, KEY); // no OS store here, so it stays in the file, under its provider
  // a key that comes from the environment must not be saved, even when another setting changes
  const home2 = fresh();
  child(home2, `const x = c.loadConfig(); x.theme = "dark"; c.saveConfig(x);`, { AMNESS_KEYSTORE: "file", OPENAI_API_KEY: KEY });
  assert.ok(!readFileSync(join(home2, "config.json"), "utf8").includes(KEY));
});

test("file backend: clearing the key removes it from the file", () => {
  const home = fresh();
  writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "openai", apiKey: KEY }));
  child(home, `const x = c.loadConfig(); x.apiKey = undefined; c.saveConfig(x);`, { AMNESS_KEYSTORE: "file" });
  assert.ok(!readFileSync(join(home, "config.json"), "utf8").includes(KEY));
});

test("macOS Keychain: a key moves out of the file, comes back on load, and is deleted on clear", { skip: process.platform !== "darwin" }, () => {
  const home = fresh(), service = `amness-test-${process.pid}-${Date.now()}`;
  const env = { AMNESS_KEYSTORE: "keychain", AMNESS_KEYSTORE_SERVICE: service };
  const f = join(home, "config.json");
  try {
    writeFileSync(f, JSON.stringify({ provider: "openai", apiKey: KEY, theme: "dark" })); // an older version's plain-text file
    assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);              // load migrates it
    const after = readFileSync(f, "utf8");
    assert.ok(!after.includes(KEY), "the key must be gone from the file");
    assert.ok(after.includes("dark"), "other settings stay");
    assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);              // and it loads from the Keychain
    child(home, `const x = c.loadConfig(); x.apiKey = "sk-other-key-9999"; c.saveConfig(x);`, env);
    assert.ok(!readFileSync(f, "utf8").includes("sk-other"));
    assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), "sk-other-key-9999");
    child(home, `const x = c.loadConfig(); x.apiKey = undefined; c.saveConfig(x);`, env);
    assert.equal(child(home, `console.log(String(c.loadConfig().apiKey))`, env), "undefined");
  } finally {
    spawnSync("security", ["delete-generic-password", "-s", service, "-a", "apiKey-openai"]);
    spawnSync("security", ["delete-generic-password", "-s", service, "-a", "apiKey-anthropic"]);
    spawnSync("security", ["delete-generic-password", "-s", service, "-a", "apiKey"]);
    assert.ok(existsSync(f));
  }
});

test("Windows DPAPI: the key is encrypted on disk, round-trips, and is removed on clear", { skip: process.platform !== "win32" }, () => {
  const home = fresh(), env = { AMNESS_KEYSTORE: "dpapi", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" };
  const f = join(home, "config.json");
  writeFileSync(f, JSON.stringify({ provider: "openai", apiKey: KEY }));
  assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$p = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString"], { input: "abcd", encoding: "utf8", timeout: 60_000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath")) });
  assert.ok(!readFileSync(f, "utf8").includes(KEY), `the key must be gone from the config file (powershell probe: status ${probe.status}, error ${probe.error}, stderr ${probe.stderr?.slice(0, 300)}, stdout length ${probe.stdout?.length})`);
  const blob = join(home, "secrets", "apiKey-openai.dpapi");
  assert.ok(existsSync(blob) && !readFileSync(blob, "utf8").includes(KEY), "the stored string is encrypted");
  assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);
  child(home, `const x = c.loadConfig(); x.apiKey = undefined; c.saveConfig(x);`, env);
  assert.ok(!existsSync(blob));
});

test("Linux system keyring: round-trips when secret-tool and a session are available", { skip: process.platform !== "linux" || spawnSync("secret-tool", ["--version"]).error !== undefined }, (t) => {
  const home = fresh(), service = `amness-test-${process.pid}-${Date.now()}`;
  const env = { AMNESS_KEYSTORE: "secret-service", AMNESS_KEYSTORE_SERVICE: service, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "" };
  const f = join(home, "config.json");
  writeFileSync(f, JSON.stringify({ provider: "openai", apiKey: KEY }));
  try {
    child(home, `c.loadConfig()`, env);
    if (readFileSync(f, "utf8").includes(KEY)) return t.skip("no unlocked keyring session here, so it fell back to the file"); // the fallback is tested above
    assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);
  } finally { spawnSync("secret-tool", ["clear", "service", service, "account", "apiKey-openai"]); }
});

test("container mode: a key typed in is kept in memory only, and a *_FILE secret is read", () => {
  const home = fresh(), secret = join(home, "openai-secret");
  writeFileSync(secret, KEY + "\n");
  const env = { AMNESS_KEYSTORE: "none", OPENAI_API_KEY_FILE: secret };
  assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);                 // read from the secret file, newline trimmed
  child(home, `const x = c.loadConfig(); x.theme = "dark"; c.saveConfig(x);`, env);
  assert.ok(!readFileSync(join(home, "config.json"), "utf8").includes(KEY));                 // and never written back
  const home2 = fresh();
  child(home2, `const x = c.loadConfig(); x.apiKey = "sk-typed-in-9999"; x.theme = "dark"; c.saveConfig(x);`, { AMNESS_KEYSTORE: "none" });
  assert.ok(!readFileSync(join(home2, "config.json"), "utf8").includes("sk-typed-in"));      // a typed key is not written to disk in a container
});

test("several providers: each keeps its own key, switching does not overwrite, env wins per provider, removing one leaves the others", () => {
  const home = fresh(), env = { AMNESS_KEYSTORE: "file" };
  child(home, `c.storeKey("openai", "sk-openai-1111"); c.storeKey("anthropic", "sk-ant-2222");`, env);
  assert.equal(child(home, `console.log(JSON.stringify(c.connections().map((x) => [x.id, x.source])))`, env), '[["anthropic","saved"],["openai","saved"],["openrouter","none"],["ollama","saved"],["custom","saved"]]');
  // the active provider's key is the one for that provider
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "config.json"), "utf8")), provider: "anthropic" }));
  assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), "sk-ant-2222");
  // switching and saving does not touch the other provider's key
  child(home, `const x = c.loadConfig(); x.provider = "openai"; x.apiKey = c.keyFor("openai").key; c.saveConfig(x);`, env);
  assert.equal(child(home, `console.log(c.keyFor("anthropic").key + " " + c.keyFor("openai").key)`, env), "sk-ant-2222 sk-openai-1111");
  // an environment variable wins for its own provider only, and is never saved
  assert.equal(child(home, `console.log(c.keyFor("anthropic").source + " " + c.keyFor("openai").source)`, { ...env, ANTHROPIC_API_KEY: "sk-ant-env" }), "env saved");
  child(home, `const x = c.loadConfig(); x.theme = "dark"; c.saveConfig(x);`, { ...env, OPENAI_API_KEY: "sk-openai-env" });
  assert.ok(!readFileSync(join(home, "config.json"), "utf8").includes("sk-openai-env"));
  child(home, `c.storeKey("anthropic", undefined)`, env);
  assert.equal(child(home, `console.log(String(c.keyFor("anthropic").key) + " " + c.keyFor("openai").key)`, env), "undefined sk-openai-1111");
});

test("a key saved by an older version (one key for the active provider) moves to that provider", () => {
  const home = fresh();
  writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "anthropic", apiKey: KEY, tavilyKey: "tvly-1234567890abcdefghij" }));
  assert.equal(child(home, `console.log(c.keyFor("anthropic").key)`, { AMNESS_KEYSTORE: "file" }) , "undefined"); // not migrated until the config is loaded
  assert.equal(child(home, `const x = c.loadConfig(); console.log(x.apiKey + " " + x.tavilyKey)`, { AMNESS_KEYSTORE: "file" }), `${KEY} tvly-1234567890abcdefghij`);
  const after = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(after.apiKey, undefined);
  assert.equal(after.apiKeys.anthropic, KEY);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Each case runs in a child process, because the key store is chosen from environment variables when the module loads.
const KEY = "sk-test-0123456789abcdefghij";
const child = (home: string, code: string, env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as c from ${JSON.stringify(join(import.meta.dirname, "../cli/config.ts"))}; ${code}`], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AMNESS_HOME: home, ...env },
  });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const fresh = () => mkdtempSync(join(tmpdir(), "amness-ks-"));

test("file backend: the key file is owner-only and an environment key is never written to it", { skip: process.platform === "win32" }, () => {
  const home = fresh();
  child(home, `const x = c.loadConfig(); x.apiKey = ${JSON.stringify(KEY)}; c.saveConfig(x);`, { AMNESS_KEYSTORE: "file" });
  const f = join(home, "config.json");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).apiKey, KEY); // no OS store here, so it stays in the file
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
    spawnSync("security", ["delete-generic-password", "-s", service, "-a", "apiKey"]);
    assert.ok(existsSync(f));
  }
});

test("Windows DPAPI: the key is encrypted on disk, round-trips, and is removed on clear", { skip: process.platform !== "win32" }, () => {
  const home = fresh(), env = { AMNESS_KEYSTORE: "dpapi", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" };
  const f = join(home, "config.json");
  writeFileSync(f, JSON.stringify({ provider: "openai", apiKey: KEY }));
  assert.equal(child(home, `console.log(c.loadConfig().apiKey)`, env), KEY);
  assert.ok(!readFileSync(f, "utf8").includes(KEY), "the key must be gone from the config file");
  const blob = join(home, "secrets", "apiKey.dpapi");
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
  } finally { spawnSync("secret-tool", ["clear", "service", service, "account", "apiKey"]); }
});

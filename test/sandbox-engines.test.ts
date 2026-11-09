import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySandboxEngine, dockerArgs, dockerSandbox, registerSandbox, runShell, sandboxBackends, sandboxKind, setSandboxBackend, wrapCommand } from "../src/index.ts";

test("sandbox engines: built-ins are listed; a plugin's engine can be chosen and runs the command; unknown or unavailable engines are refused, never skipped", async () => {
  assert.deepEqual(sandboxBackends().map((b) => b.name).slice(0, 3), ["seatbelt", "bwrap", "docker"]);
  const seen: string[] = [];
  registerSandbox({ name: "fake", label: "Fake engine", unavailable: () => undefined, wrap: (cmd, ws, mode) => { seen.push(`${mode}:${cmd}`); return { file: "sh", args: ["-c", `echo wrapped; ${cmd}`] }; } });
  registerSandbox({ name: "broken", unavailable: () => "not installed", wrap: () => ({ file: "false", args: [] }) });
  const d = mkdtempSync(join(tmpdir(), "amness-sbe-"));
  try {
    setSandboxBackend("fake"); assert.equal(sandboxKind(), "fake");
    assert.match(await runShell("echo hi", d, 10_000, undefined, "strict"), /wrapped[\s\S]*hi/); assert.deepEqual(seen, ["strict:echo hi"]);
    assert.equal(wrapCommand("x", d, "off"), undefined);                                // off is off, whatever the engine
    setSandboxBackend("broken"); assert.equal(sandboxKind(), undefined);
    assert.throws(() => wrapCommand("x", d, "workspace"), /engine broken\) but unavailable here: not installed/);
    assert.throws(() => setSandboxBackend("nosuch"), /no sandbox engine "nosuch"/);
    assert.equal(applySandboxEngine({ sandboxEngine: "nosuch" }), false);                // a bad config falls back to auto, and says so
  } finally { setSandboxBackend("auto"); }
});

test("docker engine: the project is mounted at the same path, .git read-only, no network in strict mode, and the runtime (gVisor) and image come from the settings", () => {
  const d = mkdtempSync(join(tmpdir(), "amness-dk-")); mkdirSync(join(d, ".git")); const ws = realpathSync(d);
  const before = { ...dockerSandbox };
  try {
    applySandboxEngine({ sandboxImage: "python:3.12", sandboxRuntime: "runsc" });
    assert.deepEqual(dockerArgs("pytest -q", d, "strict", "linux"), ["run", "--rm", "-i", "--runtime", "runsc", "--network", "none", "-v", `${ws}:${ws}`, "-v", `${join(ws, ".git")}:${ws}/.git:ro`, "-w", ws, "python:3.12", "sh", "-c", "pytest -q"]);
    assert.deepEqual(dockerArgs("ls", d, "workspace", "win32").slice(-10), ["-v", `${ws}:/workspace`, "-v", `${join(ws, ".git")}:/workspace/.git:ro`, "-w", "/workspace", "python:3.12", "sh", "-c", "ls"]);   // Linux containers on Windows: a fixed path inside
    applySandboxEngine({ sandboxRuntime: "" });
    assert.ok(!dockerArgs("ls", d, "workspace").includes("--network")); assert.ok(!dockerArgs("ls", d, "workspace").includes("--runtime"));
  } finally { Object.assign(dockerSandbox, before); setSandboxBackend("auto"); }
});

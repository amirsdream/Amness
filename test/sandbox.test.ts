import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager, runShell, sandboxKind, seatbeltProfile, wrapCommand } from "../src/index.ts";

const kind = sandboxKind();
const skip = kind ? false : "no OS sandbox on this machine (needs sandbox-exec on macOS or bwrap on Linux)";
const ws = () => { const d = mkdtempSync(join(tmpdir(), "amness-sb-")); mkdirSync(join(d, ".git")); writeFileSync(join(d, ".git", "HEAD"), "ref: x\n"); return d; };
const outside = () => mkdtempSync(join(process.env.HOME ?? "/", ".amness-sbtest-"));      // a folder in the user's home: outside the workspace and outside temp

test("sandbox: off runs commands as before; a requested but unavailable sandbox refuses instead of running unprotected", async () => {
  assert.equal(wrapCommand("echo hi", "/tmp", "off"), undefined);
  assert.match(await runShell("echo hi", tmpdir(), 5000, undefined, "off"), /^exit=0\nhi/);
  if (!kind) assert.match(await runShell("echo hi", "/tmp", 5000, undefined, "workspace"), /exit=126\nERROR: the sandbox is on/);
  else assert.match(seatbeltProfile("/tmp/x", "strict") + "(wrap)", /deny network|bwrap|wrap/);
});

test("sandbox: writes inside the workspace work; writes outside and into .git are blocked; reads outside still work", { skip }, async () => {
  const d = ws(), out = outside();
  try {
    assert.match(await runShell("echo ok > inside.txt && cat inside.txt", d, 10_000, undefined, "workspace"), /exit=0\nok/);
    const o1 = await runShell(`echo no > ${join(out, "x.txt")}`, d, 10_000, undefined, "workspace"); assert.ok(!o1.startsWith("exit=0") && !existsSync(join(out, "x.txt")), o1);
    const o2 = await runShell("echo no > .git/HEAD", d, 10_000, undefined, "workspace"); assert.ok(!o2.startsWith("exit=0") && readFileSync(join(d, ".git", "HEAD"), "utf8") === "ref: x\n", o2);
    assert.match(await runShell("cat .git/HEAD && ls / | head -1", d, 10_000, undefined, "workspace"), /exit=0\nref: x/);
    assert.match(await runShell("echo t > ${TMPDIR:-/tmp}/sbtest.$$ && echo temp-ok", d, 10_000, undefined, "workspace"), /temp-ok/);       // temp folders stay usable: builds need them
    const rm = await runShell(`rm -rf ${out}`, d, 10_000, undefined, "workspace"); assert.ok(existsSync(out), "rm outside the workspace must fail: " + rm);
  } finally { try { (await import("node:fs")).rmSync(out, { recursive: true, force: true }); } catch { /* */ } }
});

test("sandbox: strict mode also cuts the network, workspace mode does not", { skip }, async () => {
  const srv = createServer((s) => s.end("pong")); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const port = (srv.address() as any).port, d = ws();
  const probe = `node -e "require('net').connect(${port},'127.0.0.1').on('data',d=>{console.log('got '+d);process.exit(0)}).on('error',e=>{console.log('blocked '+e.code);process.exit(3)})"`;
  try {
    assert.match(await runShell(probe, d, 10_000, undefined, "workspace"), /got pong/);
    const strict = await runShell(probe, d, 10_000, undefined, "strict"); assert.match(strict, /blocked/, strict);
  } finally { srv.close(); }
});

test("sandbox: background processes are sandboxed too", { skip }, async () => {
  const d = ws(), out = outside(), m = new ProcessManager(d, { sandbox: () => "workspace" });
  try {
    const p = m.start(`echo no > ${join(out, "bg.txt")}; echo done`); await new Promise((r) => setTimeout(r, 800));
    const r = await m.read(p.id); assert.ok(!existsSync(join(out, "bg.txt")) && /done/.test(r.output), r.output);
  } finally { await m.dispose(); try { (await import("node:fs")).rmSync(out, { recursive: true, force: true }); } catch { /* */ } }
});

test("CI only: the OS sandbox must actually be usable here (AMNESS_REQUIRE_SANDBOX=1), so its tests are not silently skipped", { skip: !process.env.AMNESS_REQUIRE_SANDBOX && "set AMNESS_REQUIRE_SANDBOX=1 to require a working sandbox" }, () => {
  assert.ok(sandboxKind(), "no working OS sandbox on this machine (macOS needs sandbox-exec; Linux needs bubblewrap and permission to create user namespaces)");
});

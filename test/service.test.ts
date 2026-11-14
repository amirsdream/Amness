import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-svc-"));
const { servicePlan } = await import("../cli/service.ts");

test("amness service install: a launchd agent, a systemd user unit, a Windows logon task, each running amness serve with your options", () => {
  const o = { node: "/usr/bin/node", script: "/opt/amness/cli/amness.js", cwd: "/home/me/code", env: { PATH: "/usr/bin:/bin", HOME: "/home/me" }, uid: 501 };
  const mac = servicePlan(["--host", "0.0.0.0", "--root", "/home/me/code & more"], { ...o, platform: "darwin" });
  assert.match(mac.file!, /LaunchAgents\/dev\.amness\.serve\.plist$/);
  assert.match(mac.content!, /<string>serve<\/string>\s*<string>--host<\/string>\s*<string>0\.0\.0\.0<\/string>/);
  assert.match(mac.content!, /<string>\/home\/me\/code &amp; more<\/string>/);                     // escaped for XML
  assert.match(mac.content!, /<key>KeepAlive<\/key>/); assert.match(mac.content!, /<key>NO_COLOR<\/key><string>1<\/string>/);
  assert.deepEqual(mac.run.at(-1), ["launchctl", "bootstrap", "gui/501", mac.file]);
  const lin = servicePlan(["--port", "5000"], { ...o, platform: "linux" });
  assert.match(lin.file!, /systemd\/user\/amness\.service$/);
  assert.match(lin.content!, /ExecStart=\/usr\/bin\/node --no-warnings \/opt\/amness\/cli\/amness\.js serve --port 5000/);
  assert.match(lin.content!, /Restart=on-failure/); assert.match(lin.content!, /WorkingDirectory=\/home\/me\/code/);
  assert.deepEqual(lin.run.at(-1), ["systemctl", "--user", "enable", "--now", "amness.service"]); assert.match(lin.note!, /enable-linger/);
  const win = servicePlan([], { ...o, platform: "win32" });
  assert.equal(win.run[0][0], "schtasks"); assert.ok(win.run[0].includes("ONLOGON")); assert.match(win.run[0].at(-1)!, /serve/);
});

test("amness-desktop --connect: says clearly when nothing answers or the token is wrong", async () => {
  const run = (args: string[]) => new Promise<{ code: number | null; err: string }>((ok) => { const p = spawn("node", ["--no-warnings", "cli/desktop.ts", ...args], { env: { ...process.env, NO_COLOR: "1" } }); let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => ok({ code, err })); });
  const none = await run(["--connect", "http://127.0.0.1:9/", "--token", "x"]); assert.equal(none.code, 1); assert.match(none.err, /no amness serve answers/);
  const noTok = await run(["--connect", "127.0.0.1:9"]); assert.equal(noTok.code, 2); assert.match(noTok.err, /give the token/);
  const { startDesktopServer } = await import("../cli/desktop/server.ts"), { ApiSessions } = await import("../cli/serve/sessions.ts"), { v1Routes } = await import("../cli/serve/api.ts");
  const cfg = { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "m", maxTokens: 1000 } as any, dir = mkdtempSync(join(tmpdir(), "amness-conn-"));
  const v1 = v1Routes(new ApiSessions({ cfg, version: "0", roots: [dir], defaultCwd: dir, persist: false }), { version: "0" });
  const srv = await startDesktopServer({ cfg, cwd: dir, version: "0", persist: false, net: { token: "right-token-0123456789abcdef", extra: v1.handler } });
  try { const bad = await run(["--connect", `http://127.0.0.1:${srv.port}/`, "--token", "wrong"]); assert.equal(bad.code, 2); assert.match(bad.err, /refused the token/); }
  finally { v1.close(); await srv.close(); }
});

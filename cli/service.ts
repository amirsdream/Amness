// `amness service …`: run `amness serve` in the background and at login, with the operating system's own service manager:
// a launchd agent on macOS, a systemd user unit on Linux, a logon task on Windows. Plain files you can read; nothing runs as root.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { home } from "./config.ts";
import { serveToken } from "./serve.ts";
import { bold, cyan, dim, green, red, yellow } from "./ui.ts";

export const SERVICE_HELP = `amness service <command>   run amness serve in the background, and again at login
  install [serve options]   write and start the service (macOS launchd, Linux systemd --user, Windows logon task)
                            e.g. amness service install --host 0.0.0.0 --root ~/code   (see amness serve --help)
  uninstall                 stop it and remove it
  start · stop · restart · status
  logs                      the last lines of its output
  --dry-run                 with install: print what would be written and run, change nothing`;

const LABEL = "dev.amness.serve", UNIT = "amness.service", TASK = "Amness serve";
export type ServicePlan = { platform: NodeJS.Platform; file?: string; content?: string; run: string[][]; note?: string };
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sysq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
const winq = (s: string) => (/^[\w\-.:\\/=@]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The node on your PATH when it is the same program as this one (a Homebrew Cellar path changes at every upgrade; the PATH one does not). */
function stableNode(): string {
  try { const r = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" }); const p = r.stdout.split(/\r?\n/)[0]?.trim(); if (r.status === 0 && p && existsSync(p)) return p; } catch { /* use ours */ }
  return process.execPath;
}
/** What install writes and runs on this platform, for the given `amness serve` arguments. Pure, so it can be shown (--dry-run) and tested. */
export function servicePlan(args: string[], o: { platform?: NodeJS.Platform; node?: string; script?: string; cwd?: string; env?: NodeJS.ProcessEnv; uid?: number } = {}): ServicePlan {
  const platform = o.platform ?? process.platform, node = o.node ?? stableNode(), script = ((p: string) => ((platform === "win32" ? win32 : posix).isAbsolute(p) ? p : resolve(p)))(o.script ?? process.argv[1]), cwd = o.cwd ?? process.cwd(), env = o.env ?? process.env;
  const argv = [node, "--no-warnings", script, "serve", ...args];
  const keep: Record<string, string> = { PATH: env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1", ...(env.AMNESS_HOME && { AMNESS_HOME: env.AMNESS_HOME }), ...(env.HOME && { HOME: env.HOME }) };
  const pj = platform === "win32" ? win32.join : posix.join, hd = env.HOME ?? homedir();                                 // paths for the target system, wherever the plan is made
  const log = pj(home(), "serve.out.log");
  if (platform === "darwin") {
    const file = pj(hd, "Library", "LaunchAgents", `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(keep).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    const uid = o.uid ?? process.getuid?.() ?? 501;
    return { platform, file, content, run: [["launchctl", "bootout", `gui/${uid}/${LABEL}`], ["launchctl", "bootstrap", `gui/${uid}`, file]] };
  }
  if (platform === "win32") {
    const cmd = argv.map(winq).join(" ");
    return { platform, run: [["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", TASK, "/TR", `cmd /c cd /d ${winq(cwd)} && ${cmd} >> ${winq(log)} 2>&1`], ["schtasks", "/Run", "/TN", TASK]], note: "a logon task: it starts when you sign in" };
  }
  const file = pj(env.XDG_CONFIG_HOME ?? pj(hd, ".config"), "systemd", "user", UNIT);
  const content = `[Unit]
Description=Amness serve (the Amness app and HTTP API)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${argv.map(sysq).join(" ")}
${Object.entries(keep).map(([k, v]) => `Environment=${sysq(`${k}=${v}`)}`).join("\n")}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
  return { platform, file, content, run: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", UNIT]], note: "to keep it running when you are logged out: loginctl enable-linger $USER" };
}

const sh = (cmd: string[], quiet = false) => { const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" }); if (!quiet && r.status !== 0 && (r.stderr || r.stdout)) process.stderr.write(dim((r.stderr || r.stdout).trim() + "\n")); return r.status === 0; };

export async function runService(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") { console.log(SERVICE_HELP); return cmd ? 0 : 1; }
  const p = process.platform, uid = process.getuid?.() ?? 501;
  if (cmd === "install") {
    const dry = rest.includes("--dry-run"), args = rest.filter((a) => a !== "--dry-run");
    const plan = servicePlan(args);
    if (dry) { if (plan.file) console.log(`${bold(plan.file)}\n${plan.content}`); for (const c of plan.run) console.log(`$ ${c.join(" ")}`); return 0; }
    serveToken();                                                                                // make the token now, so you can see it before the first client connects
    if (plan.file) { mkdirSync(dirname(plan.file), { recursive: true }); writeFileSync(plan.file, plan.content!); console.log(`${green("✓")} wrote ${plan.file}`); }
    let ok = true; plan.run.forEach((c, i) => { const r = sh(c, p === "darwin" && i === 0); if (!(p === "darwin" && i === 0)) ok &&= r; });   // bootout fails when it was not loaded: fine
    if (!ok) { console.error(`${red("✗")} the service manager refused; see the message above`); return 1; }
    console.log(`${green("●")} amness serve runs in the background and at login ${dim(plan.note ? `(${plan.note})` : "")}`);
    console.log(`  token: ${cyan("amness serve token")} · output: ${join(home(), "serve.out.log")} · ${cyan("amness service status")}`);
    return 0;
  }
  if (cmd === "uninstall") {
    if (p === "darwin") { const f = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`); sh(["launchctl", "bootout", `gui/${uid}/${LABEL}`], true); if (existsSync(f)) rmSync(f); }
    else if (p === "win32") sh(["schtasks", "/Delete", "/F", "/TN", TASK]);
    else { sh(["systemctl", "--user", "disable", "--now", UNIT], true); const f = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT); if (existsSync(f)) rmSync(f); sh(["systemctl", "--user", "daemon-reload"], true); }
    console.log(`${green("✓")} removed the amness serve service`); return 0;
  }
  if (cmd === "logs") { const f = join(home(), "serve.out.log"); console.log(existsSync(f) ? readFileSync(f, "utf8").split("\n").slice(-60).join("\n") : dim("no output yet")); return 0; }
  const map: Record<string, Record<string, string[][]>> = {
    darwin: { start: [["launchctl", "kickstart", `gui/${uid}/${LABEL}`]], stop: [["launchctl", "kill", "TERM", `gui/${uid}/${LABEL}`]], restart: [["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`]], status: [["launchctl", "print", `gui/${uid}/${LABEL}`]] },
    win32: { start: [["schtasks", "/Run", "/TN", TASK]], stop: [["schtasks", "/End", "/TN", TASK]], restart: [["schtasks", "/End", "/TN", TASK], ["schtasks", "/Run", "/TN", TASK]], status: [["schtasks", "/Query", "/TN", TASK]] },
    linux: { start: [["systemctl", "--user", "start", UNIT]], stop: [["systemctl", "--user", "stop", UNIT]], restart: [["systemctl", "--user", "restart", UNIT]], status: [["systemctl", "--user", "status", "--no-pager", UNIT]] },
  };
  const steps = (map[p] ?? map.linux)[cmd];
  if (!steps) { console.error(`unknown command "service ${cmd}"\n\n${SERVICE_HELP}`); return 2; }
  if (cmd === "status") {
    const r = spawnSync(steps[0][0], steps[0].slice(1), { encoding: "utf8" });
    if (r.status !== 0) { console.log(`${yellow("○")} not installed or not running ${dim("(amness service install)")}`); return 1; }
    const running = p === "darwin" ? /state = running/.test(r.stdout) : p === "win32" ? /Running/.test(r.stdout) : /active \(running\)/.test(r.stdout);
    console.log(`${running ? green("●") : yellow("○")} amness serve ${running ? "is running" : "is installed but not running"}`); return running ? 0 : 1;
  }
  for (const c of steps) if (!sh(c)) return 1;
  console.log(`${green("✓")} ${cmd}`); return 0;
}

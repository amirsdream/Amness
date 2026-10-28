// `amness schedule`: recurring headless runs via cron.
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { add, cronLines, ensureLogDir, load, mergeCrontab, remove } from "../src/index.ts";
import { bold, dim, green, red } from "./ui.ts";

export const SCHEDULE_HELP = `usage: amness schedule <command>
  add <name> "<cron>" "<task>" [--verify <cmd>]   save a recurring task for this project (5-field cron, e.g. "0 3 * * 1-5")
  list                                            show this project's schedules
  remove <name>                                   delete one
  install [--write]                               print the crontab lines; with --write, put them in your crontab (only a marked block for this project is touched)
  uninstall                                       remove this project's block from your crontab
  Runs are headless (\`amness run --json\`), risky commands are denied, and each run's output is appended to .amness/schedule-logs/<name>.jsonl.
  Cron must be able to find \`amness\` and your API key; set them in the crontab environment or use a wrapper script.`;

export function runSchedule(argv: string[], cwd = process.cwd()): number {
  const root = resolve(cwd), [cmd, ...rest] = argv;
  const val = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (!cmd || cmd === "--help" || cmd === "-h") { console.log(SCHEDULE_HELP); return cmd ? 0 : 2; }
    if (cmd === "add") { const [name, cron, task] = rest; add(root, { name, cron, task, verify: val("--verify") }); console.log(`saved "${name}". Run \`amness schedule install\` to see the crontab line.`); return 0; }
    if (cmd === "list") { const l = load(root); if (!l.length) console.log("no schedules for this project"); for (const s of l) console.log(`${bold(s.name.padEnd(16))} ${s.cron.padEnd(14)} ${s.task}${s.verify ? dim("  verify: " + s.verify) : ""}`); return 0; }
    if (cmd === "remove") { console.log(remove(root, rest[0]) ? `removed "${rest[0]}"` : `no schedule named "${rest[0]}"`); return 0; }
    if (cmd === "install" || cmd === "uninstall") {
      const lines = cmd === "install" ? cronLines(root, load(root)) : [];
      if (cmd === "install" && !rest.includes("--write")) { console.log(lines.length ? lines.join("\n") : "no schedules to install"); console.log(dim("\n(not written; pass --write to add these to your crontab)")); return 0; }
      let current = ""; try { current = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { /* none yet */ }
      ensureLogDir(root);
      const r = spawnSync("crontab", ["-"], { input: mergeCrontab(current, root, lines), encoding: "utf8" });
      if (r.status !== 0) throw new Error("crontab refused the update: " + (r.stderr || "unknown error").trim());
      console.log(green(cmd === "install" ? `installed ${lines.length} schedule(s) in your crontab` : "removed this project's schedules from your crontab")); return 0;
    }
    console.error(SCHEDULE_HELP); return 2;
  } catch (e) { console.error(red("✗ " + (e as Error).message)); return 2; }
}

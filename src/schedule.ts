// Recurring headless runs. Schedules live in .amness/schedules.json; `amness schedule install` turns them into crontab lines (printed by default; written only with --write,
// inside a marked block so removing them is exact). Each run is `amness run --json` with its output kept in .amness/schedule-logs/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Schedule = { name: string; cron: string; task: string; verify?: string; extra?: string[] };
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
/** Strict 5-field cron check (numbers, ranges, lists, steps, `*`). Names like MON are not accepted, to keep what runs unambiguous. */
export function validCron(expr: string): string | undefined {
  const f = expr.trim().split(/\s+/); if (f.length !== 5) return "a schedule needs 5 fields: minute hour day-of-month month day-of-week";
  for (let i = 0; i < 5; i++) for (const part of f[i].split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part); if (!m) return `field ${i + 1} (${f[i]}) is not valid`;
    const [lo, hi] = RANGES[i], nums = m[1] === "*" ? [] : m[1].split("-").map(Number);
    if (nums.some((n) => n < lo || n > hi) || (nums.length === 2 && nums[0] > nums[1])) return `field ${i + 1} (${f[i]}) is out of range ${lo}-${hi}`;
    if (m[2] !== undefined && Number(m[2]) < 1) return `field ${i + 1} step must be at least 1`;
  }
  return undefined;
}
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const file = (cwd: string) => join(cwd, ".amness", "schedules.json");
export function load(cwd: string): Schedule[] { try { return JSON.parse(readFileSync(file(cwd), "utf8")); } catch { return []; } }
export function save(cwd: string, list: Schedule[]) { mkdirSync(dirname(file(cwd)), { recursive: true }); writeFileSync(file(cwd), JSON.stringify(list, null, 2) + "\n"); }
export function add(cwd: string, s: Schedule): void {
  const bad = validCron(s.cron); if (bad) throw new Error(bad);
  if (!/^[\w.-]{1,40}$/.test(s.name)) throw new Error("the name may use letters, numbers, . _ - (40 characters at most)");
  if (!s.task.trim()) throw new Error("a schedule needs a task");
  const list = load(cwd).filter((x) => x.name !== s.name); list.push(s); save(cwd, list);
}
export function remove(cwd: string, name: string): boolean { const l = load(cwd), n = l.filter((x) => x.name !== name); save(cwd, n); return n.length !== l.length; }

const BEGIN = (cwd: string) => `# >>> amness schedules for ${cwd} >>>`, END = (cwd: string) => `# <<< amness schedules for ${cwd} <<<`;
/** The crontab lines for these schedules. Runs are denied risky commands (no --yes) unless the schedule says otherwise in `extra`. */
export function cronLines(cwd: string, list: Schedule[], bin = "amness"): string[] {
  return list.map((s) => `${s.cron} cd ${sq(cwd)} && ${bin} run --json ${s.verify ? `--verify ${sq(s.verify)} ` : ""}${(s.extra ?? []).map(sq).join(" ")}${s.extra?.length ? " " : ""}${sq(s.task)} >> ${sq(join(cwd, ".amness", "schedule-logs", s.name + ".jsonl"))} 2>&1`);
}
/** `current` crontab text with this project's block replaced by `lines` (or removed when empty). Everything else is kept byte for byte. */
export function mergeCrontab(current: string, cwd: string, lines: string[]): string {
  const b = BEGIN(cwd), e = END(cwd), i = current.indexOf(b), j = current.indexOf(e);
  const rest = i >= 0 && j > i ? current.slice(0, i) + current.slice(j + e.length).replace(/^\n/, "") : current;
  const base = rest.replace(/\n*$/, rest.trim() ? "\n" : "");
  return lines.length ? `${base}${b}\n${lines.join("\n")}\n${e}\n` : base;
}
export function ensureLogDir(cwd: string) { mkdirSync(join(cwd, ".amness", "schedule-logs"), { recursive: true }); }
export const hasSchedules = (cwd: string) => existsSync(file(cwd));

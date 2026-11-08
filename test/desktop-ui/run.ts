import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "../../cli/desktop/server.ts";
import { electronBinary } from "../../cli/desktop.ts";
import { loadState, saveState } from "../../cli/state.ts";
import type { Message, Model } from "../../src/index.ts";
// Drives the real desktop window (Electron) with a scripted model and checks that it works the way a person uses it: typing, clicking, dialogs, panels.
// Needs a screen, so it is not part of `npm test`: run `npm run test:desktop-ui` (exits 1 when a check fails). Optional arguments: a check script, a screenshot path.
const args = process.argv.slice(2).filter((a) => a !== "--chats"), sizeAt = args.indexOf("--size"), size = sizeAt >= 0 ? args.splice(sizeAt, 2)[1] : undefined;
const evalFile = args[0] ? fileURLToPath(new URL(args[0], `file://${process.cwd()}/`)) : fileURLToPath(new URL("./check.js", import.meta.url)), shot = args[1];
process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
const dir = join(mkdtempSync(join(tmpdir(), "ui-")), "billing-service"); mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "src/paginate.ts"), "export function paginate<T>(items: T[], page: number, size: number): T[] {\n  const start = page * size;\n  const out: T[] = [];\n  for (let i = start; i < start + size - 1; i++) out.push(items[i]);\n  return out;\n}\n");
writeFileSync(join(dir, "src/invoice.ts"), "import { paginate } from './paginate';\nexport const pages = (xs: number[]) => paginate(xs, 0, 10);\n");
let n = 0; const u = { prompt_tokens: 4200, completion_tokens: 180, total_tokens: 4380, cached_tokens: 3100 };
const c = (name: string, args: unknown): Message => ({ role: "assistant", content: null, usage: u, tool_calls: [{ id: `x${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const replies: Message[] = [
  { ...c("read_file", { path: "src/paginate.ts" }), content: "I'll look at the pagination helper first." }, c("grep", { pattern: "paginate" }), c("read_file", { path: "src/invoice.ts" }),
  { ...c("edit_file", { path: "src/paginate.ts", old: "i < start + size - 1", new: "i < Math.min(start + size, items.length)" }), content: "Found it: the loop stops one item early." },
  { role: "assistant", content: "Fixed the off-by-one in `src/paginate.ts:4`. Each page now has `size` items and the last page has no `undefined` rows.", usage: u },
];
const model: Model = async (_m, _s, o) => { await new Promise((x) => setTimeout(x, 120)); const r = replies.shift() ?? { role: "assistant", content: "ok", usage: u }; if (r.content && o?.onThinking) o.onThinking("Looking at the loop bounds in paginate…"); if (r.content && o?.onText) o.onText(r.content); return r; };
if (process.argv.includes("--chats")) {
  saveState({ ...loadState(), trustedDirs: [dir] });                                // it saves for real, so the folder-trust question would come first                                         // saved conversations from several days, for the conversation list
  const chats = join(dir, ".amness", "chats"); mkdirSync(chats, { recursive: true });
  const H = 3600_000, now = Date.now();
  const mk = (title: string, agoMs: number, turns: number, said: [string, string]) => { const id = `c${Math.random().toString(36).slice(2, 9)}`;
    writeFileSync(join(chats, id + ".json"), JSON.stringify({ id, created: new Date(now - agoMs).toISOString(), updated: new Date(now - agoMs).toISOString(), title, cwd: dir, model: "gpt-6.1-sol", usage: { prompt: 0, completion: 0, calls: 0, series: [] },
      turns: Array.from({ length: turns }, (_, i) => ({ at: i, text: title, t: now, snaps: {} })), messages: [{ role: "user", content: said[0] }, { role: "assistant", content: said[1] }] })); };
  mk("Fix flaky invoice export test", 4 * 60_000, 3, ["The invoice export test fails one run in ten.", "It depends on the clock; I froze time in the test."]);
  mk("Add retry to webhook sender", 3 * H, 5, ["Webhooks drop when the receiver is slow.", "Added backoff with jitter, capped at 5 tries."]);
  mk("Speed up CI with test sharding", 4 * 24 * H, 6, ["CI takes 18 minutes.", "Split into 4 shards; it now takes 6."]);
  mk("Rename customer to account across the API", 40 * 24 * H, 9, ["Rename customer to account.", "Renamed in 41 files, with an alias."]);
  for (let d = 10; d < 18; d++) mk(`Older task from ${d} days ago`, d * 24 * H, 2, ["An older request.", "An older answer."]);   // always "Previous 30 days": folded, and more than the cap
}
const srv = await startDesktopServer({ cfg: { provider: "openai", baseUrl: "http://x/v1", model: "gpt-6.1-sol", maxTokens: 300000, apiKey: "sk-test" } as any, cwd: dir, version: "0.1.8", persist: process.argv.includes("--chats"), makeModel: () => model });
const env: NodeJS.ProcessEnv = { ...process.env, AMNESS_DESKTOP_URL: srv.url, AMNESS_DESKTOP_EVAL: evalFile, ...(size ? { AMNESS_DESKTOP_SIZE: size } : {}), ...(shot ? { AMNESS_DESKTOP_SCREENSHOT: shot } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
const ch = spawn(electronBinary()!, [fileURLToPath(new URL("../../cli/desktop/electron-main.cjs", import.meta.url))], { stdio: ["ignore", "pipe", "ignore"], env });
let out = ""; ch.stdout.on("data", (d) => (out += d));
ch.on("exit", async () => {
  const m = /AMNESS_EVAL (.*)/.exec(out), r = m ? JSON.parse(m[1]) : { error: "no result from the window" };
  const failed = Object.entries(r).filter(([, v]) => v === false || (v && typeof v === "object" && !Array.isArray(v)));
  for (const [k, v] of Object.entries(r)) console.log(`${v === false || k === "error" ? "✗" : "✓"} ${k}${typeof v === "boolean" ? "" : ": " + JSON.stringify(v)}`);
  await srv.close(); process.exit(failed.length || r.error ? 1 : 0);
});

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "../../cli/desktop/server.ts";
import { electronBinary } from "../../cli/desktop.ts";
import type { Message, Model } from "../../src/index.ts";
// Drives the real desktop window (Electron) with a scripted model and checks that it works the way a person uses it: typing, clicking, dialogs, panels.
// Needs a screen, so it is not part of `npm test`: run `npm run test:desktop-ui` (exits 1 when a check fails). Optional arguments: a check script, a screenshot path.
const args = process.argv.slice(2), sizeAt = args.indexOf("--size"), size = sizeAt >= 0 ? args.splice(sizeAt, 2)[1] : undefined;
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
const srv = await startDesktopServer({ cfg: { provider: "openai", baseUrl: "http://x/v1", model: "gpt-6.1-sol", maxTokens: 300000, apiKey: "sk-test" } as any, cwd: dir, version: "0.1.8", persist: false, makeModel: () => model });
const env: NodeJS.ProcessEnv = { ...process.env, AMNESS_DESKTOP_URL: srv.url, AMNESS_DESKTOP_EVAL: evalFile, ...(size ? { AMNESS_DESKTOP_SIZE: size } : {}), ...(shot ? { AMNESS_DESKTOP_SCREENSHOT: shot } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
const ch = spawn(electronBinary()!, [fileURLToPath(new URL("../../cli/desktop/electron-main.cjs", import.meta.url))], { stdio: ["ignore", "pipe", "ignore"], env });
let out = ""; ch.stdout.on("data", (d) => (out += d));
ch.on("exit", async () => {
  const m = /AMNESS_EVAL (.*)/.exec(out), r = m ? JSON.parse(m[1]) : { error: "no result from the window" };
  const failed = Object.entries(r).filter(([, v]) => v === false || (v && typeof v === "object" && !Array.isArray(v)));
  for (const [k, v] of Object.entries(r)) console.log(`${v === false || k === "error" ? "✗" : "✓"} ${k}${typeof v === "boolean" ? "" : ": " + JSON.stringify(v)}`);
  await srv.close(); process.exit(failed.length || r.error ? 1 : 0);
});

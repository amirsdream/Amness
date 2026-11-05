import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "../../cli/desktop/server.ts";
import { electronBinary } from "../../cli/desktop.ts";
import type { Message, Model } from "../../src/index.ts";
// Window check for subagents and thinking: three explorers in parallel must share one card (a row each), and thinking must show in the status line while
// the turn runs and as one collapsed item per turn afterwards. Part of `npm run test:desktop-ui`; exits 1 when a check fails.
const evalFile = process.argv[2] ?? fileURLToPath(new URL("./agents-check.js", import.meta.url)), shot = process.argv[3];
process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
const dir = join(mkdtempSync(join(tmpdir(), "ag-")), "billing-service"); mkdirSync(join(dir, "src"), { recursive: true });
for (const f of ["auth.ts", "routes.ts", "jest.config.js"]) writeFileSync(join(dir, "src", f), "export const x = 1;\n");
const u = { prompt_tokens: 3000, completion_tokens: 100, total_tokens: 3100 };
let n = 0; const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null, usage: u, tool_calls: [{ id: `k${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// lead: one message with three task calls; each explorer: two reads then finish; lead: final answer
const lead: Message[] = [
  { role: "assistant", content: null, usage: u, tool_calls: ["find where tokens are refreshed", "map the API routes", "check how tests are set up"].map((d) => ({ id: `t${++n}`, function: { name: "task", arguments: JSON.stringify({ description: d }) } })) },
  { role: "assistant", content: "Tokens refresh in `src/auth.ts`, routes live in `src/routes.ts`, and tests use Jest.", usage: u },
];
const model: Model = async (msgs, _s, o) => {
  const sys = String(msgs[0]?.content ?? "");
  if (/read-only code explorer/.test(sys)) {                                     // a subagent
    const steps = msgs.filter((m) => m.role === "assistant").length; await sleep(400 + Math.random() * 400);
    if (steps < 2) return call("read_file", { path: ["src/auth.ts", "src/routes.ts", "src/jest.config.js"][steps % 3] });
    return call("finish", { summary: "Found it in `src/auth.ts`." });
  }
  o?.onThinking?.("Splitting this into three parallel explorations… ");
  await sleep(300);
  const r = lead.shift() ?? { role: "assistant", content: "ok", usage: u }; if (r.content) { o?.onThinking?.("Summarising what the agents found."); o?.onText?.(r.content); } return r;
};
const srv = await startDesktopServer({ cfg: { provider: "openai", baseUrl: "http://x/v1", model: "gpt-6.1-sol", maxTokens: 300000, apiKey: "sk" } as any, cwd: dir, version: "0.1.8", persist: false, makeModel: () => model });
const env: NodeJS.ProcessEnv = { ...process.env, AMNESS_DESKTOP_URL: srv.url, AMNESS_DESKTOP_EVAL: evalFile, ...(shot ? { AMNESS_DESKTOP_SCREENSHOT: shot } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
const ch = spawn(electronBinary()!, [fileURLToPath(new URL("../../cli/desktop/electron-main.cjs", import.meta.url))], { stdio: ["ignore", "pipe", "ignore"], env });
let out = ""; ch.stdout.on("data", (d) => (out += d));
const expect: Record<string, unknown> = { liveCard: true, thinkingLiveInChat: true, noThinkingAboveComposer: true, thinkingFoldsWhenNextPartStarts: true, separateTaskCards: 0, thinkingOnlyInsideWork: true, thinkingFoldedInWork: true, rowOpens: true, panelHasNoAgentsDup: true };
ch.on("exit", async () => {
  const m = /AMNESS_EVAL (.*)/.exec(out), r = m ? JSON.parse(m[1]) : {};
  let bad = m ? 0 : 1;
  for (const [k, want] of Object.entries(expect)) { const ok = r[k] === want; if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${k}${ok ? "" : `: got ${JSON.stringify(r[k])}, want ${JSON.stringify(want)}`}`); }
  await srv.close(); process.exit(bad ? 1 : 0);
});

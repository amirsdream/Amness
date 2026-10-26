// Drives the real App with fake keystrokes and a scripted model, and reads the result back through a VT emulator.
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "../../src/index.ts";
import { App } from "../../cli/tui/app.ts";
import { strip } from "../../cli/tui/text.ts";
import { VTerm } from "./vterm.ts";

export type Reply = Message | ((msgs: Message[], tools: string[], o: { onText?: (d: string) => void; signal?: AbortSignal }) => Message | Promise<Message>);
let n = 0;
export const call = (name: string, args: unknown, content: string | null = null): Message => ({ role: "assistant", content, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  tool_calls: [{ id: `c${++n}`, function: { name, arguments: JSON.stringify(args) } }] });
export const say = (content: string): Message => ({ role: "assistant", content, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };

export const KEY = { enter: "\r", esc: "\x1b", tab: "\t", backtab: "\x1b[Z", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", ctrlC: "\x03", ctrlD: "\x04", ctrlO: "\x0f", altEnter: "\x1b\r", bs: "\x7f" };

export function rig(replies: Reply[], o: { files?: Record<string, string>; cols?: number; rows?: number; resume?: string; prompt?: string; ui?: "full" | "inline"; theme?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "amness-app-"));
  process.env.AMNESS_HOME = mkdtempSync(join(tmpdir(), "amness-home-"));
  for (const [f, c] of Object.entries(o.files ?? { "README.md": "# Demo\nhello\n", "a.txt": "one\ntwo\n" })) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
  const cols = o.cols ?? 80, rows = o.rows ?? 30, vt = new VTerm(cols, rows);
  const input: any = Object.assign(new EventEmitter(), { setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
  const output = { write: (s: string) => vt.write(s), columns: cols, rows, on() {} };
  const seen: { msgs: Message[]; tools: string[] }[] = [];
  const queue = [...replies];
  const model: Model = async (msgs, specs, opts) => {
    seen.push({ msgs: msgs.map((m) => ({ ...m })), tools: specs.map((s) => s.name) });
    const r = queue.shift(); if (!r) return say("(script exhausted)");
    const m = typeof r === "function" ? await r(msgs, specs.map((s) => s.name), opts ?? {}) : r;
    if (typeof r !== "function" && m.content && opts?.onText) { for (const part of m.content.match(/.{1,12}/gs) ?? []) { opts.onText(part); await sleep(1); } }
    return m;
  };
  const app = new App({ ui: o.ui, cfg: { provider: "custom", baseUrl: "http://x/v1", model: "test-model", maxTokens: 100000, theme: o.theme } as any, cwd: dir, version: "0.0.0", input, output, makeModel: () => model, persist: false, resume: o.resume, prompt: o.prompt });
  const t = {
    dir, vt, app, seen, input,
    start: async () => { void app.start(); await sleep(40); },
    type: async (s: string, wait = 40) => { input.emit("data", s); await sleep(wait); },
    key: async (k: string, wait = 60) => { input.emit("data", k); await sleep(wait); },
    text: () => vt.all().join("\n"),
    screen: () => vt.screen().join("\n"),
    settle: async (ms = 120) => { await sleep(ms); },
    until: async (pred: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(15); } return pred(); },
    has: (re: RegExp | string) => (typeof re === "string" ? t.text().includes(re) : re.test(t.text())),
    idle: () => !app.running,
    submit: async (text: string) => { await t.type(text); await t.key(KEY.enter); },
  };
  return t;
}
export const plain = strip;

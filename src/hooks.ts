// Lifecycle hooks: your own commands, run at fixed points of the agent loop, that can block a step, rewrite a tool call, or add context.
// Same vocabulary as Claude Code and Codex, so a hook script written for one is easy to move.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellInvocation } from "./shell.ts";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact" | "Stop" | "PreModel" | "PostModel";
export const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop", "PreModel", "PostModel"];
export type HookDef = { /** tool names this applies to, as a regex (tool events only); default: all */ match?: string; command: string; /** seconds, default 10 */ timeout?: number; /** a crash or timeout blocks instead of being ignored */ failClosed?: boolean };
export type HookConfig = Partial<Record<HookEvent, HookDef[]>>;
export type HookResult = { block?: string; context?: string; args?: Record<string, unknown>; /** PreModel only: the tools that may be called in this turn (a call to any other is refused with an explanation) */ tools?: string[]; /** PreModel only: a text-only reply to this request is not the final answer; add this message and ask for the next step (for a planning phase) */ then?: string; warnings: string[] };
export type HookRunner = { run(event: HookEvent, payload: Record<string, unknown>): Promise<HookResult>; count(): number };

/** The environment a hook sees: no API keys, tokens or passwords. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i.test(k)) out[k] = v;
  return out;
}

const readCfg = (file: string): HookConfig => {
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, "utf8")) as HookConfig, out: HookConfig = {};
  for (const ev of HOOK_EVENTS) { const list = j[ev]; if (list === undefined) continue; if (!Array.isArray(list)) throw new Error(`${file}: "${ev}" must be a list of { command, match?, timeout? }`); for (const d of list) if (!d || typeof d.command !== "string") throw new Error(`${file}: every "${ev}" hook needs a "command" string`); out[ev] = list; }
  return out;
};

export class Hooks implements HookRunner {
  private cfg: HookConfig; private cwd: string; private env: NodeJS.ProcessEnv;
  constructor(cfg: HookConfig, cwd: string, env: NodeJS.ProcessEnv = scrubbedEnv()) { this.cfg = cfg; this.cwd = cwd; this.env = env; }
  /** Where project hooks live, and a fingerprint of their content (to remember that the user approved exactly this file). */
  static projectFile(cwd: string) { return join(cwd, ".amness", "hooks.json"); }
  static fingerprint(cwd: string): string | undefined { const f = Hooks.projectFile(cwd); return existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) : undefined; }
  /** User-level hooks always load; project hooks only when `trustProject` (a cloned repo must not run commands on your machine unasked). */
  static load(cwd: string, o: { trustProject?: boolean; userDir?: string } = {}): Hooks {
    const user = readCfg(join(o.userDir ?? process.env.AMNESS_HOME ?? join(homedir(), ".amness"), "hooks.json")), project = o.trustProject ? readCfg(Hooks.projectFile(cwd)) : {};
    const merged: HookConfig = {}; for (const ev of HOOK_EVENTS) { const l = [...(user[ev] ?? []), ...(project[ev] ?? [])]; if (l.length) merged[ev] = l; }
    return new Hooks(merged, cwd);
  }
  count() { return HOOK_EVENTS.reduce((n, ev) => n + (this.cfg[ev]?.length ?? 0), 0); }
  list(): { event: HookEvent; def: HookDef }[] { return HOOK_EVENTS.flatMap((event) => (this.cfg[event] ?? []).map((def) => ({ event, def }))); }

  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookResult> {
    const res: HookResult = { warnings: [] };
    for (const def of this.cfg[event] ?? []) {
      if (def.match && typeof payload.tool === "string" && !new RegExp(`^(?:${def.match})$`).test(payload.tool)) continue;
      const r = await this.exec(def, { event, cwd: this.cwd, ...payload });
      if (r.warning) { if (def.failClosed) { res.block = r.warning; break; } res.warnings.push(r.warning); continue; }
      if (r.block !== undefined) { res.block = r.block; break; }
      if (r.context) res.context = (res.context ? res.context + "\n" : "") + r.context;
      if (r.args) res.args = r.args;
    }
    return res;
  }

  private exec(def: HookDef, input: object): Promise<{ block?: string; context?: string; args?: Record<string, unknown>; warning?: string }> {
    return new Promise((done) => {
      const inv = shellInvocation(def.command), p = spawn(inv.file, inv.args, { windowsHide: true, cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "", settled = false;
      const finish = (v: Parameters<typeof done>[0]) => { if (!settled) { settled = true; clearTimeout(timer); done(v); } };
      const timer = setTimeout(() => { p.kill("SIGKILL"); finish({ warning: `hook \`${def.command}\` timed out after ${def.timeout ?? 10}s` }); }, (def.timeout ?? 10) * 1000);
      p.stdout.on("data", (d) => { if (out.length < 20_000) out += d; }); p.stderr.on("data", (d) => { if (err.length < 20_000) err += d; });
      p.on("error", (e) => finish({ warning: `hook \`${def.command}\` could not start: ${e.message}` }));
      p.stdin.on("error", () => {}); p.stdin.end(JSON.stringify(input));
      p.on("close", (code) => {
        if (code === 2) return finish({ block: (err.trim() || out.trim() || `blocked by hook \`${def.command}\``).slice(0, 2000) });
        if (code !== 0) return finish({ warning: `hook \`${def.command}\` exited with ${code}${err.trim() ? ": " + err.trim().slice(0, 300) : ""}` });
        const text = out.trim(); if (!text) return finish({});
        try {
          const j = JSON.parse(text) as { decision?: string; reason?: string; context?: string; args?: Record<string, unknown> };
          if (j && typeof j === "object") return finish(j.decision === "block" ? { block: j.reason ?? "blocked by hook" } : { context: j.context, args: j.args && typeof j.args === "object" ? j.args : undefined });
        } catch { /* plain text */ }
        finish({ context: text.slice(0, 4000) });
      });
    });
  }
}

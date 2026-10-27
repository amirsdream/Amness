// Background processes: start a dev server or a watcher, read its output later, stop it. Output is kept in a bounded buffer; everything is killed on dispose().
import { spawn, type ChildProcess } from "node:child_process";
import { wrapCommand, type SandboxMode } from "./sandbox.ts";
import { childEnv } from "./secrets.ts";

export type ProcInfo = { id: string; name: string; cmd: string; pid?: number; status: "running" | "exited" | "killed"; code?: number | null; startedAt: number; bytes: number };
type Proc = ProcInfo & { child: ChildProcess; buf: string; dropped: number; readPos: number; waiters: (() => void)[] };
const CAP = 200_000;

export class ProcessManager {
  private procs = new Map<string, Proc>(); private n = 0; private cwd: string; private max: number; private sandbox: () => SandboxMode;
  constructor(cwd: string, o: { max?: number; sandbox?: () => SandboxMode } = {}) { this.cwd = cwd; this.max = o.max ?? 5; this.sandbox = o.sandbox ?? (() => "off"); }

  start(cmd: string, name?: string): ProcInfo {
    if ([...this.procs.values()].filter((p) => p.status === "running").length >= this.max) throw new Error(`already running ${this.max} background processes; stop one with sh_stop first`);
    const id = `p${++this.n}`;
    const w = wrapCommand(cmd, this.cwd, this.sandbox());            // throws when a sandbox is on but unavailable
    const child = spawn(w?.file ?? "sh", w?.args ?? ["-c", cmd], { cwd: this.cwd, env: childEnv(process.env, this.sandbox() !== "off"), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const p: Proc = { id, name: name?.slice(0, 40) || cmd.split(/\s+/).slice(0, 3).join(" ").slice(0, 40), cmd, pid: child.pid, status: "running", startedAt: Date.now(), bytes: 0, child, buf: "", dropped: 0, readPos: 0, waiters: [] };
    const take = (d: Buffer) => {
      const s = d.toString("utf8"); p.bytes += s.length; p.buf += s;
      if (p.buf.length > CAP) { const cut = p.buf.length - CAP; p.buf = p.buf.slice(cut); p.dropped += cut; p.readPos = Math.max(0, p.readPos - cut); }
      for (const w of p.waiters.splice(0)) w();
    };
    child.stdout!.on("data", take); child.stderr!.on("data", take);
    child.on("error", (e) => { p.status = "exited"; p.code = -1; take(Buffer.from(`[could not start: ${e.message}]\n`)); });
    child.on("close", (code) => { if (p.status === "running") { p.status = "exited"; p.code = code; } for (const w of p.waiters.splice(0)) w(); });
    this.procs.set(id, p);
    return this.info(p);
  }

  private get(id: string): Proc { const p = this.procs.get(id); if (!p) throw new Error(`no background process "${id}". Running: ${this.list().map((x) => x.id).join(", ") || "none"}`); return p; }
  private info(p: Proc): ProcInfo { const { child: _c, buf: _b, dropped: _d, readPos: _r, waiters: _w, ...i } = p; return i; }
  list(): ProcInfo[] { return [...this.procs.values()].map((p) => this.info(p)); }

  /** Output produced since the last read. With `waitMs`, waits (up to that long) for new output or for the process to end. */
  async read(id: string, o: { waitMs?: number; maxChars?: number } = {}): Promise<{ output: string; status: ProcInfo["status"]; code?: number | null; skipped: number }> {
    const p = this.get(id);
    if (p.readPos >= p.buf.length && p.status === "running" && o.waitMs) await new Promise<void>((res) => { const t = setTimeout(res, Math.min(o.waitMs!, 10_000)); p.waiters.push(() => { clearTimeout(t); res(); }); });
    const max = o.maxChars ?? 8000; let skipped = p.dropped; p.dropped = 0;
    let out = p.buf.slice(p.readPos); p.readPos = p.buf.length;
    if (out.length > max) { skipped += out.length - max; out = out.slice(-max); }
    return { output: out, status: p.status, code: p.code, skipped };
  }

  async stop(id: string): Promise<ProcInfo> {
    const p = this.get(id);
    if (p.status === "running") {
      p.status = "killed";
      const kill = (sig: NodeJS.Signals) => { try { if (p.pid) process.kill(-p.pid, sig); } catch { try { p.child.kill(sig); } catch { /* already gone */ } } };
      kill("SIGTERM");
      await new Promise<void>((res) => { const t = setTimeout(() => { kill("SIGKILL"); res(); }, 2000); p.child.once("close", () => { clearTimeout(t); res(); }); });
    }
    return this.info(p);
  }

  /** Kill everything still running (call on exit). */
  async dispose() { await Promise.all([...this.procs.values()].filter((p) => p.status === "running").map((p) => this.stop(p.id))); }
  /** Synchronous last-resort kill for process 'exit' handlers. */
  killAllNow() { for (const p of this.procs.values()) if (p.status === "running" && p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } } }
}

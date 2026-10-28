// Language-server diagnostics after edits: the compiler's opinion of the file you just changed, one step after the edit instead of at the end of the task. A tiny LSP client over stdio
// (no dependencies). Servers are started lazily, only when one is installed, kept alive between edits and stopped on dispose(). Errors only, capped, and silent when all is well.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type LspServer = { name: string; command: string; args: string[]; extensions: string[]; languageId: (ext: string) => string };
export const DEFAULT_SERVERS: LspServer[] = [
  { name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"], languageId: (e) => ({ ".ts": "typescript", ".tsx": "typescriptreact", ".jsx": "javascriptreact", ".mts": "typescript", ".cts": "typescript" })[e] ?? "javascript" },
  { name: "python", command: "pyright-langserver", args: ["--stdio"], extensions: [".py"], languageId: () => "python" },
  { name: "go", command: "gopls", args: [], extensions: [".go"], languageId: () => "go" },
  { name: "rust", command: "rust-analyzer", args: [], extensions: [".rs"], languageId: () => "rust" },
];
export type Diagnostic = { line: number; col: number; message: string; severity: number; source?: string };
const onPath = (bin: string) => { try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; } };

class Client {
  private p: ChildProcess; private buf = Buffer.alloc(0); private id = 0; private pending = new Map<number, (v: any) => void>();
  diags = new Map<string, { version: number; list: Diagnostic[]; waiters: (() => void)[] }>(); private versions = new Map<string, number>(); ready: Promise<boolean>; dead = false;
  readonly server: LspServer; private root: string;
  constructor(server: LspServer, root: string) {
    this.server = server; this.root = root;
    this.p = spawn(server.command, server.args, { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    this.p.on("error", () => { this.dead = true; }); this.p.on("close", () => { this.dead = true; for (const w of this.pending.values()) w(undefined); });
    this.p.stdout!.on("data", (d: Buffer) => this.onData(d)); this.p.stdin!.on("error", () => { this.dead = true; });
    this.ready = this.request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: true } } }, workspaceFolders: [{ uri: pathToFileURL(root).href, name: "ws" }] }, 15_000).then((r) => { if (!r) return false; this.notify("initialized", {}); return true; });
  }
  private send(msg: object) { if (this.dead) return; const body = JSON.stringify({ jsonrpc: "2.0", ...msg }); this.p.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
  notify(method: string, params: object) { this.send({ method, params }); }
  request(method: string, params: object, timeout = 8000): Promise<any> {
    if (this.dead) return Promise.resolve(undefined);
    return new Promise((res) => { const id = ++this.id, t = setTimeout(() => { this.pending.delete(id); res(undefined); }, timeout); this.pending.set(id, (v) => { clearTimeout(t); res(v); }); this.send({ id, method, params }); });
  }
  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = this.buf.indexOf("\r\n\r\n"); if (h < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, h).toString()); if (!m) { this.buf = this.buf.slice(h + 4); continue; }
      const len = Number(m[1]), end = h + 4 + len; if (this.buf.length < end) return;
      const body = this.buf.slice(h + 4, end).toString("utf8"); this.buf = this.buf.slice(end);
      let msg: any; try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && msg.method) this.send({ id: msg.id, result: null });                       // a request from the server (configuration, registerCapability...): acknowledge it
      else if (msg.id !== undefined) this.pending.get(msg.id)?.(msg.result ?? {}), this.pending.delete(msg.id);
      else if (msg.method === "textDocument/publishDiagnostics") {
        const uri = msg.params.uri as string, e = this.diags.get(uri) ?? { version: 0, list: [], waiters: [] };
        e.list = (msg.params.diagnostics ?? []).map((x: any) => ({ line: (x.range?.start?.line ?? 0) + 1, col: (x.range?.start?.character ?? 0) + 1, message: String(x.message ?? "").split("\n")[0], severity: x.severity ?? 1, source: x.source }));
        e.version++; this.diags.set(uri, e); for (const w of e.waiters.splice(0)) w();
      }
    }
  }
  /** Tell the server about the file's new content and wait (briefly) for its verdict. */
  async check(file: string, languageId: string, ms = 5000): Promise<Diagnostic[] | undefined> {
    if (!(await this.ready) || this.dead) return undefined;
    const uri = pathToFileURL(file).href, text = readFileSync(file, "utf8"), v = (this.versions.get(uri) ?? 0) + 1, had = this.versions.has(uri); this.versions.set(uri, v);
    const e = this.diags.get(uri) ?? { version: 0, list: [], waiters: [] }; this.diags.set(uri, e); const before = e.version;
    if (!had) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: v, text } }); else { this.notify("textDocument/didChange", { textDocument: { uri, version: v }, contentChanges: [{ text }] }); this.notify("textDocument/didSave", { textDocument: { uri }, text }); }
    if (e.version === before) await new Promise<void>((res) => { const t = setTimeout(res, ms); e.waiters.push(() => { clearTimeout(t); setTimeout(res, 150); }); });      // a short grace period lets a second, fuller publish arrive
    return e.version === before ? undefined : e.list;
  }
  async stop() { if (this.dead) return; try { await this.request("shutdown", {}, 1500); this.notify("exit", {}); } catch { /* gone */ } setTimeout(() => this.p.kill(), 300).unref(); }
}

export class Diagnostics {
  private clients = new Map<string, Client>(); private root: string; private servers: LspServer[]; private missing = new Set<string>();
  constructor(root: string, o: { servers?: LspServer[] } = {}) { this.root = resolve(root); this.servers = o.servers ?? DEFAULT_SERVERS; }
  /** Which server would handle this file, if one is installed. */
  serverFor(path: string): LspServer | undefined { const ext = extname(path).toLowerCase(), s = this.servers.find((x) => x.extensions.includes(ext)); if (!s || this.missing.has(s.name)) return undefined; if (!onPath(s.command)) { this.missing.add(s.name); return undefined; } return s; }
  async errors(path: string): Promise<Diagnostic[] | undefined> {
    const s = this.serverFor(path); if (!s) return undefined;
    const abs = resolve(this.root, path); if (!existsSync(abs)) return undefined;
    let c = this.clients.get(s.name); if (!c || c.dead) { c = new Client(s, this.root); this.clients.set(s.name, c); }
    const all = await c.check(abs, s.languageId(extname(path).toLowerCase())); return all?.filter((d) => d.severity === 1);
  }
  /** Text to append to an edit result: the errors the language server reports for these files, or "" when there are none (or no server). */
  async report(paths: string[]): Promise<string> {
    const out: string[] = [];
    for (const p of [...new Set(paths)].slice(0, 4)) { const errs = await this.errors(p).catch(() => undefined); for (const d of (errs ?? []).slice(0, 6)) out.push(`${p}:${d.line}:${d.col}  ${d.message}${d.source ? ` (${d.source})` : ""}`); }
    return out.length ? `\n\n[language server: ${out.length} error(s) in the file${new Set(paths).size > 1 ? "s" : ""} you just changed; fix them before moving on]\n${out.join("\n")}` : "";
  }
  async dispose() { await Promise.all([...this.clients.values()].map((c) => c.stop())); this.clients.clear(); }
  installed(): string[] { return this.servers.filter((s) => onPath(s.command)).map((s) => s.name); }
}

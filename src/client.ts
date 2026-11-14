// A small client for `amness serve`'s /v1 API (docs/api.md), for scripts, CI and other programs. No dependencies: fetch and Server-Sent Events.
//   const c = new AmnessClient({ url: "http://127.0.0.1:4747", token });
//   const r = await c.run("fix the failing test", { mode: "acceptEdits", onDialog: (d) => 0 });   // answer each approval (0 = the first option)
export type ClientDialog = { id: number; kind: "choice" | "pick" | "input" | "text" | "longtext"; title?: string; question?: string; prompt?: string; body?: string[]; options?: { label: string; hint?: string }[]; items?: { label: string; hint?: string }[] };
export type ClientSession = { id: string; title: string; cwd: string; model: string; provider: string; mode: string; status: "idle" | "running" | "waiting"; turns: number; dialog?: ClientDialog; lastAnswer?: string };
export type ClientEvent = { type: string; session: string; [k: string]: any };

export class AmnessClient {
  private base: string; private token: string;
  constructor(o: { url: string; token: string }) { this.base = o.url.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/#.*$/, ""); this.token = o.token; }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base + path, { method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j: any; try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text }; }
    if (!r.ok) throw Object.assign(new Error(`amness serve: ${r.status} ${j?.error ?? text}`), { status: r.status });
    return j as T;
  }
  health() { return this.req<{ ok: boolean; version: string; sessions: number }>("GET", "/v1/health"); }
  sessions(saved?: string) { return this.req<{ open: ClientSession[]; saved?: unknown[] }>("GET", `/v1/sessions${saved !== undefined ? `?saved=${encodeURIComponent(saved)}` : ""}`); }
  create(o: { cwd?: string; resume?: string; model?: string; mode?: "default" | "acceptEdits" | "plan" | "yolo"; title?: string } = {}) { return this.req<ClientSession>("POST", "/v1/sessions", o); }
  get(id: string) { return this.req<ClientSession>("GET", `/v1/sessions/${id}`); }
  send(id: string, text: string, o: { wait?: boolean; timeoutMs?: number } = {}) { return this.req<{ accepted: boolean; session: ClientSession; text?: string }>("POST", `/v1/sessions/${id}/messages`, { text, ...o }); }
  answer(id: string, dialogId: number, value: number | string | null) { return this.req<{ ok: boolean }>("POST", `/v1/sessions/${id}/dialog`, { id: dialogId, value }); }
  interrupt(id: string) { return this.req<ClientSession>("POST", `/v1/sessions/${id}/interrupt`); }
  mode(id: string, mode: "default" | "acceptEdits" | "plan" | "yolo") { return this.req<ClientSession>("POST", `/v1/sessions/${id}/mode`, { mode }); }
  command(id: string, command: string) { return this.req<{ lines: string[] }>("POST", `/v1/sessions/${id}/commands`, { command }); }
  items(id: string, since = 0) { return this.req<{ items: { id: number; kind: string; [k: string]: any }[] }>("GET", `/v1/sessions/${id}/items?since=${since}`); }
  close(id: string) { return this.req<{ ok: boolean }>("DELETE", `/v1/sessions/${id}`); }

  /** Server-Sent Events: of one session, or of all. Stop with `signal`. */
  async *events(id?: string, signal?: AbortSignal): AsyncGenerator<ClientEvent> {
    const r = await fetch(`${this.base}/v1/${id ? `sessions/${id}/` : ""}events`, { headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" }, signal });
    if (!r.ok || !r.body) throw new Error(`amness serve: events ${r.status}`);
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    try {
      for (;;) {
        const { value, done } = await rd.read(); if (done) return;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (data) { try { yield JSON.parse(data); } catch { /* not JSON */ } }
        }
      }
    } finally { rd.releaseLock(); }
  }

  /**
   * One task from start to answer: open a session (or use `session`), send `text`, answer every dialog with `onDialog`
   * (an option index; null cancels, which says no to an approval), and return the final answer. Closes the session it opened unless `keep`.
   */
  async run(text: string, o: { session?: string; cwd?: string; model?: string; mode?: "default" | "acceptEdits" | "plan" | "yolo"; onDialog?: (d: ClientDialog) => number | string | null | Promise<number | string | null>; timeoutMs?: number; keep?: boolean } = {}) {
    const s = o.session ? await this.get(o.session) : await this.create({ cwd: o.cwd, model: o.model, mode: o.mode });
    const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000);
    try {
      let r = await this.send(s.id, text, { wait: true, timeoutMs: deadline - Date.now() });
      while (r.session.status !== "idle" && Date.now() < deadline) {
        if (r.session.status === "waiting" && r.session.dialog) {
          const v = o.onDialog ? await o.onDialog(r.session.dialog) : null;
          await this.answer(s.id, r.session.dialog.id, v);
        }
        await new Promise((res) => setTimeout(res, 200));
        const v = await this.get(s.id);
        r = { accepted: true, session: v, ...(v.status === "idle" && { text: v.lastAnswer }) };
      }
      return { session: r.session, text: r.text ?? r.session.lastAnswer ?? "", finished: r.session.status === "idle" };
    } finally { if (!o.session && !o.keep) await this.close(s.id).catch(() => {}); }
  }
}

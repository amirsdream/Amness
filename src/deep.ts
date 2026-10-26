import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHarness, defineTool, type Approve, type Budget, type Event, type Message, type Model, type Tool } from "./harness.ts";
import { webTools, type SearchProvider } from "./web.ts";

/** In-memory virtual filesystem, optionally mirrored to `dir` so work and memory survive across runs. */
export class VFS {
  files = new Map<string, string>();
  dir?: string;
  constructor(dir?: string) {
    this.dir = dir;
    if (dir && existsSync(dir)) (function walk(d: string, base: string, f: Map<string, string>) {
      for (const e of readdirSync(d)) {
        if (e.startsWith(".")) continue;
        const p = join(d, e);
        statSync(p).isDirectory() ? walk(p, base + "/" + e, f) : f.set(base + "/" + e, readFileSync(p, "utf8"));
      }
    })(dir, "", this.files);
  }
  norm(p: string) { return "/" + p.split("/").filter((x) => x && x !== "." && x !== "..").join("/"); }
  read(p: string) { const f = this.files.get(this.norm(p)); if (f === undefined) throw new Error(`no such file: ${p}. Use ls.`); return f; }
  write(p: string, c: string) {
    p = this.norm(p); this.files.set(p, c);
    if (this.dir) { const abs = resolve(this.dir, "." + p); if (abs.startsWith(resolve(this.dir) + sep)) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, c); } }
  }
  ls(prefix = "/") { const x = this.norm(prefix); return [...this.files].filter(([k]) => k.startsWith(x)).map(([k, v]) => `${k}  (${v.length} chars)`).join("\n") || "(empty)"; }
}

export type Todo = { task: string; status: "pending" | "in_progress" | "done" };
export type SubAgent = { name: string; description: string; system: string; tools?: Tool[] };

export type DeepOptions = {
  model: Model;
  /** Extra tools for the lead agent and all subagents (the web tools are included by default). */
  tools?: Tool[];
  search?: SearchProvider;
  web?: boolean;
  /** Subagent types the lead can delegate to via `task`. A general-purpose one always exists. */
  subagents?: SubAgent[];
  /** Persist the virtual filesystem here (e.g. ./.amness) so later runs see earlier files. */
  dir?: string;
  maxSteps?: number;
  subMaxSteps?: number;
  /** One cap shared by the lead and every subagent. */
  budget?: Budget;
  /** Asked before any `risky` tool (yours, or anything you add). Default: deny. */
  approve?: Approve;
  /** Reject a report that cites URLs the agents never actually saw (search results or fetched pages), or cites none. Default true. */
  citations?: boolean;
  /** Tool results longer than this are saved to /offload/* and replaced by a preview + path. */
  offloadAt?: number;
  onEvent?: (e: Event & { agent?: string }) => void;
};

const LEAD = `You are a deep agent: you tackle open-ended, multi-step tasks by planning, delegating, and writing things down.

Method:
1. PLAN FIRST. Call \`write_todos\` with a short ordered list. Keep exactly one item in_progress. Update it as you go; the plan is your memory.
2. DELEGATE. Use \`task\` for any self-contained research or analysis chunk. Subagents have fresh context and return only a summary, so give each a complete, specific brief (they see nothing else). Issue independent \`task\` calls in the same turn so they run in parallel.
3. OFFLOAD. Long material lives in files (\`write_file\`/\`read_file\`), not in your head. Tool output that is too long is saved to /offload/ for you; read only the parts you need.
4. REFLECT. After each batch of findings call \`think\`: what is established, what is missing or contradictory, what to do next.
5. VERIFY. Cross-check important claims against at least two independent sources. Say so when you can't.
6. DELIVER. Write the final deliverable to /report.md with sources as URLs, then call \`finish\` with a short summary. \`finish\` is rejected while todos are open or /report.md is missing.

Never invent facts, URLs or quotes. Prefer primary sources. Be concise.`;

const SUB = `You are a focused research/analysis subagent working for a lead agent. You cannot see its conversation; your brief is all you have.
Do the assigned job thoroughly using your tools (search with several varied queries, read primary sources, cross-check). Save bulky raw material to files if useful.
Finish with \`finish\`: a dense summary of findings (facts, numbers, source URLs, confidence, open questions). The lead sees only that summary, so make it self-contained.
Never invent facts or URLs.`;

export function createDeepAgent(o: DeepOptions) {
  const fs = new VFS(o.dir);
  let todos: Todo[] = [];
  let offloads = 0;
  const emit = (agent: string) => (e: Event) => o.onEvent?.({ ...e, agent });
  const offloadAt = o.offloadAt ?? 5000;
  const seenUrls = new Set<string>();
  const urlKey = (u: string) => u.replace(/[).,;:'"\]>]+$/, "").replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
  const urlsIn = (t: string) => (t.match(/https?:\/\/[^\s<>"'`\])]+/g) ?? []).map(urlKey);
  /** Record every URL a web tool returned or fetched, so the report's citations can be checked against reality. */
  const track = (t: Tool): Tool => !["web_search", "fetch_url"].includes(t.name) ? t : ({
    ...t, run: async (a: any, ctx) => {
      const r = String(await t.run(a, ctx));
      if (t.name === "fetch_url") seenUrls.add(urlKey(a.url)); else urlsIn(r).forEach((u) => seenUrls.add(u));
      return r;
    },
  });

  /** Large results go to a file (reversible) instead of being compressed (lossy). */
  const offload = (t: Tool): Tool => ({
    ...t,
    run: async (a, ctx) => {
      const r = await t.run(a, ctx);
      const s = typeof r === "string" ? r : JSON.stringify(r) ?? "ok";
      if (s.length <= offloadAt) return s;
      const path = `/offload/${++offloads}-${t.name}.txt`;
      fs.write(path, s);
      return `${s.slice(0, 1200)}\n...\n[${s.length} chars total, saved to ${path}. read_file it with start/end to see more]`;
    },
  });

  const fileTools: Tool[] = [
    defineTool<{ path?: string }>({ name: "ls", description: "List files in the shared virtual filesystem.",
      schema: { type: "object", properties: { path: { type: "string" } } }, run: ({ path }) => fs.ls(path) }),
    defineTool<{ path: string; start?: number; end?: number }>({ name: "read_file", description: "Read a file (optionally lines start..end, 1-based).",
      schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } } },
      run: ({ path, start, end }) => fs.read(path).split("\n").slice((start ?? 1) - 1, end).map((l, i) => `${(start ?? 1) + i}\t${l}`).join("\n") }),
    defineTool<{ path: string; content: string }>({ name: "write_file", description: "Create or overwrite a file.",
      schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
      run: ({ path, content }) => (fs.write(path, content), `wrote ${content.length} chars to ${fs.norm(path)}`) }),
    defineTool<{ path: string; old: string; new: string }>({ name: "edit_file", description: "Replace one exact, unique occurrence of `old` with `new`.",
      schema: { type: "object", required: ["path", "old", "new"], properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } } },
      run: ({ path, old, new: nw }) => {
        const s = fs.read(path), n = s.split(old).length - 1;
        if (n !== 1) return `ERROR: \`old\` matched ${n} times; it must match exactly once.`;
        fs.write(path, s.replace(old, () => nw)); return "edited " + fs.norm(path);
      } }),
  ];

  const think = defineTool<{ note: string }>({
    name: "think", description: "Reflect: distill what you've learned, what's missing, and the next step. Appends to /notes.md.",
    schema: { type: "object", required: ["note"], properties: { note: { type: "string" } } },
    run: ({ note }) => (fs.write("/notes.md", (fs.files.get("/notes.md") ?? "") + `- ${note}\n`), "noted. Continue."),
  });

  const shared = [...(o.web === false ? [] : webTools(o.search).map(track)), ...(o.tools ?? []), ...fileTools, think].map(offload);

  const subs = new Map<string, SubAgent>([["general", { name: "general", description: "General-purpose researcher with web, file and reflection tools.", system: SUB }]]);
  for (const s of o.subagents ?? []) subs.set(s.name, { ...s, system: s.system + "\n\n" + SUB });

  const task = defineTool<{ agent?: string; description: string }>({
    name: "task", parallel: true,
    description: `Delegate a self-contained job to a subagent with fresh context; returns only its summary. Agents: ${[...subs.values()].map((s) => `${s.name} (${s.description})`).join("; ")}.`,
    schema: { type: "object", required: ["description"], properties: { agent: { type: "string" }, description: { type: "string", description: "Complete brief: goal, scope, what to return. The subagent sees nothing else." } } },
    run: async ({ agent, description }) => {
      const s = subs.get(agent ?? "general");
      if (!s) return `ERROR: unknown agent "${agent}". Available: ${[...subs.keys()].join(", ")}`;
      const r = await createHarness({
        model: o.model, system: s.system, tools: [...shared, ...(s.tools ?? []).map(offload)], maxSteps: o.subMaxSteps ?? 20,
        budget: o.budget, approve: o.approve, onEvent: emit(s.name),
      }).run(description);
      return r.finished ? r.text : `(subagent did not finish cleanly) ${r.text}`;
    },
  });

  const todoTool = defineTool<{ todos: Todo[] }>({
    name: "write_todos", description: "Set the full plan (replaces the old one). Statuses: pending | in_progress | done.",
    schema: { type: "object", required: ["todos"], properties: { todos: { type: "array", items: { type: "object", required: ["task", "status"],
      properties: { task: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "done"] } } } } } },
    run: ({ todos: t }) => { todos = t; return "plan:\n" + t.map((x, i) => `${i + 1}. [${x.status}] ${x.task}`).join("\n"); },
  });

  const lead = createHarness({
    model: o.model, system: LEAD, tools: [todoTool, task, ...shared], maxSteps: o.maxSteps ?? 60,
    onEvent: emit("lead"), budget: o.budget, approve: o.approve,
    checkpoint: o.dir ? (m) => {
      mkdirSync(o.dir!, { recursive: true });
      writeFileSync(join(o.dir!, ".checkpoint.json"), JSON.stringify({ messages: m, todos, urls: [...seenUrls] }));
    } : undefined,
    verify: () => {
      if (!todos.length) return "You have no plan. Call write_todos, do the work, then finish.";
      const open = todos.filter((t) => t.status !== "done");
      if (open.length) return `Open todos: ${open.map((t) => t.task).join("; ")}. Complete them (or remove them via write_todos if obsolete).`;
      const report = fs.files.get("/report.md");
      if (report === undefined) return "Write the deliverable to /report.md first.";
      if (o.citations !== false && o.web !== false) {
        const cited = [...new Set(urlsIn(report))];
        if (!cited.length) return "/report.md cites no sources. Add the URLs that support each claim.";
        const bogus = cited.filter((u) => !seenUrls.has(u));
        if (bogus.length) return `/report.md cites URLs no agent ever saw (possible hallucination): ${bogus.slice(0, 8).join(", ")}. Remove them, or fetch/search to confirm them, then fix the report.`;
      }
    },
  });

  return {
    fs,
    get todos() { return todos; },
    /** Run to completion; returns the report text (from /report.md) plus the lead's summary. */
    async run(goal: string, opts: { resume?: boolean } = {}) {
      let resume: Message[] | undefined;
      const cp = o.dir && join(o.dir, ".checkpoint.json");
      if (opts.resume && cp && existsSync(cp)) {
        const j = JSON.parse(readFileSync(cp, "utf8"));
        resume = j.messages; todos = j.todos ?? []; (j.urls ?? []).forEach((u: string) => seenUrls.add(u));
      }
      const r = await lead.run(goal, { resume });
      return { ...r, report: fs.files.get("/report.md") };
    },
  };
}

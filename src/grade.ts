// Online evaluation: grade sessions that really happened (from .amness/traces) with graders written as functions, the same way an eval grades a finished task.
// Offline evals tell you how a harness does on tasks you wrote; this tells you how it is doing on the work you actually gave it.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SessionToolCall = { name: string; args: Record<string, unknown>; result?: string; ok?: boolean };
export type Session = {
  file: string; id: string; task: string; finished: boolean; steps: number; tokens: number; cachedTokens: number; rejections: number; denials: number; loops: number;
  toolCalls: SessionToolCall[]; filesChanged: string[]; /** the final assistant text */ answer: string;
};
export type GraderResult = number | boolean | { score: number | boolean; note?: string } | void;
export type Grader = (s: Session) => GraderResult | Promise<GraderResult>;

export function readSession(file: string): Session {
  const s: Session = { file, id: file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, ""), task: "", finished: false, steps: 0, tokens: 0, cachedTokens: 0, rejections: 0, denials: 0, loops: 0, toolCalls: [], filesChanged: [], answer: "" };
  const byId = new Map<string, SessionToolCall>(), changed = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue; let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === "run") { const u = [...(e.messages ?? [])].reverse().find((m: any) => m.role === "user"); s.task = String(u?.content ?? s.task).split("\n\n")[0].slice(0, 300); }
    else if (e.kind === "model") {
      for (const c of e.message?.tool_calls ?? []) { let args: Record<string, unknown> = {}; try { args = JSON.parse(c.function?.arguments || "{}"); } catch { /* keep empty */ } const t: SessionToolCall = { name: c.function?.name, args }; s.toolCalls.push(t); byId.set(c.id, t); }
      if (!e.message?.tool_calls?.length && e.message?.content) s.answer = String(e.message.content);
    } else if (e.kind === "tool") { const t = byId.get(e.id); if (t) { t.result = String(e.result ?? "").slice(0, 2000); t.ok = e.ok !== false; } }
    else if (e.kind === "turn") { s.steps++; s.tokens += Number(e.prompt ?? 0) + Number(e.completion ?? 0); s.cachedTokens += Number(e.cached ?? 0); }
    else if (e.kind === "finish") { s.finished = true; if (e.summary) s.answer = String(e.summary); }
    else if (e.kind === "rejected") s.rejections++; else if (e.kind === "denied") s.denials++; else if (e.kind === "loop") s.loops++;
    else if (e.kind === "edit" && e.path) changed.add(String(e.path));
  }
  s.filesChanged = [...changed]; return s;
}
export function sessionFiles(inputs: string[]): string[] {
  return inputs.flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(p, f)) : [p]));
}

/** Ready-made graders: each returns 1 when the session looks good and 0 when not (or a fraction). */
export const BUILTIN_GRADERS: Record<string, Grader> = {
  finished: (s) => s.finished,
  "no-rejections": (s) => ({ score: s.rejections === 0, note: s.rejections ? `${s.rejections} finish attempt(s) rejected` : undefined }),
  "tool-errors": (s) => { const n = s.toolCalls.filter((t) => t.ok === false).length; return { score: s.toolCalls.length ? 1 - n / s.toolCalls.length : 1, note: n ? `${n} of ${s.toolCalls.length} tool calls failed` : undefined }; },
  "no-loops": (s) => s.loops === 0,
  "verified-edits": (s) => (s.filesChanged.length ? s.toolCalls.some((t) => t.name === "sh" && /\b(test|build|tsc|lint|pytest|cargo|go test)\b/.test(String(t.args.cmd ?? "")) && t.ok !== false) : true),
};

export type GradeReport = { grader: string; sessions: number; mean: number; low: { session: string; task: string; score: number; note?: string }[] };
export async function gradeSessions(files: string[], graders: Record<string, Grader>): Promise<GradeReport[]> {
  const sessions = files.map(readSession).filter((s) => s.toolCalls.length || s.steps), out: GradeReport[] = [];
  for (const [name, g] of Object.entries(graders)) {
    const scores: { session: string; task: string; score: number; note?: string }[] = [];
    for (const s of sessions) {
      let r: GraderResult; try { r = await g(s); } catch (e) { continue; }
      if (r === undefined) continue; const raw = typeof r === "object" ? r.score : r, note = typeof r === "object" ? r.note : undefined;
      scores.push({ session: s.id, task: s.task, score: typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw), note });
    }
    out.push({ grader: name, sessions: scores.length, mean: scores.length ? scores.reduce((n, x) => n + x.score, 0) / scores.length : NaN, low: scores.filter((x) => x.score < 1).sort((a, b) => a.score - b.score).slice(0, 5) });
  }
  return out;
}

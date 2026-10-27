// An independent, skeptical reviewer. Builders overpraise their own work, and a separate judge is easier to tune towards scepticism than a builder is to make self-critical.
// Two parts: a CONTRACT of testable acceptance criteria agreed before the work starts, and a REVIEW of the finished work against it, in a fresh context that cannot edit anything.
import { codeTools, runShell } from "./code.ts";
import { Budget, clip, createHarness, defineTool, type Model, type Tool } from "./harness.ts";
import { BUILD_CMD, TEST_CMD } from "./ledger.ts";
import { parseLooseJson } from "./schema.ts";

export type ReviewResult = { pass: boolean; findings: string[]; inconclusive?: boolean };

const CONTRACT_SYSTEM = "You write acceptance criteria for a coding task before anyone starts it. Be concrete and checkable: each criterion must be verifiable by reading the diff or running a command. Do not describe how to implement. 3 to 7 criteria, each one sentence. Reply with ONLY a JSON array of strings.";

/** Testable acceptance criteria for `task`. Returns [] when the model's reply cannot be used (the work simply proceeds without a contract). */
export async function proposeContract(model: Model, task: string, budget?: Budget): Promise<string[]> {
  try {
    const m = await model([{ role: "system", content: CONTRACT_SYSTEM }, { role: "user", content: `Task:\n${clip(task, 6000)}` }], []);
    budget?.add(m);
    const j = parseLooseJson(m.content ?? "");
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string" && x.trim().length > 3).map((x) => x.trim().slice(0, 300)).slice(0, 7) : [];
  } catch { return []; }
}

const REVIEW_SYSTEM = `You are a skeptical code reviewer. Someone else did this work; assume it is wrong until the evidence shows otherwise.
- Do NOT trust their summary. Judge from the diff, the files, and commands you run yourself.
- Check every acceptance criterion. For each one decide: met (with the evidence you saw) or not met (say exactly what is wrong or missing).
- Look for what they did not do: untouched call sites, missing edge cases, weakened tests, unrelated changes.
- You can read files and run checks with the tools; you cannot change anything.
- When done, call finish with a summary that is ONLY this JSON: {"pass": boolean, "findings": ["one specific problem per entry, empty if none"]}.
Pass only if every criterion is met and you found no real problem. Style opinions are not findings.`;

/** Read-only tools plus a runner for the project's own checks (tests, build, lint); nothing else can execute. */
function reviewerTools(cwd: string, allow: RegExp[]): Tool[] {
  const read = codeTools(cwd, { mode: () => "plan" }).filter((t) => ["list_files", "read_file", "grep"].includes(t.name));
  const run = defineTool<{ cmd: string }>({ name: "run_check", description: "Run one of the project's own checks (tests, build, typecheck, lint) and see the result. Other commands are refused.", readOnly: true,
    schema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" } } },
    run: async ({ cmd }) => (!/[;&|<>`$()]/.test(cmd) && allow.some((re) => re.test(cmd)) ? clip(await runShell(cmd, cwd, 180_000), 4000) : "ERROR: only the project's test, build, typecheck and lint commands may be run here (one command, no chaining)") });
  return [...read, run];
}

export async function reviewWork(o: { model: Model; cwd: string; task: string; contract: string[]; summary: string; diffs: string; commands: string; verify?: string; budget?: Budget; signal?: AbortSignal }): Promise<ReviewResult> {
  const allow = [TEST_CMD, BUILD_CMD, ...(o.verify ? [new RegExp("^\\s*" + o.verify.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"))] : [])];
  const prompt = `## Task\n${clip(o.task, 4000)}\n\n## Acceptance criteria\n${o.contract.length ? o.contract.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(none were written; judge against the task itself)"}\n\n## What the author says they did\n${clip(o.summary, 2000)}\n\n## Changes (diffs)\n${o.diffs || "(no file was edited)"}\n\n## Commands the author ran\n${o.commands || "(none)"}`;
  try {
    const r = await createHarness({ model: o.model, system: REVIEW_SYSTEM, tools: reviewerTools(o.cwd, allow), maxSteps: 14, budget: o.budget, signal: o.signal }).run(prompt);
    const j = r.finished ? (parseLooseJson(r.text) as { pass?: unknown; findings?: unknown } | null) : null;
    if (!j || typeof j !== "object" || typeof j.pass !== "boolean") return { pass: true, findings: [], inconclusive: true };      // an unusable verdict must not block the work
    const findings = Array.isArray(j.findings) ? j.findings.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.slice(0, 500)).slice(0, 8) : [];
    return { pass: j.pass && findings.length === 0, findings: j.pass ? findings : findings.length ? findings : ["the reviewer rejected the work without saying why"] };
  } catch { return { pass: true, findings: [], inconclusive: true }; }
}

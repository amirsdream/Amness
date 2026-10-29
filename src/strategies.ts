// Loop strategies, written as plugins on the PreModel event: they change *when* the model may use which tools, without replacing the loop (so the budget, permissions, ledger and
// tracing all keep working). They are also examples of what you can build yourself: copy one and change it. `amness eval --variants full,strategy:plan-first` measures one against the default.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "./plugins.ts";

const READ_TOOLS = ["list_files", "read_file", "grep", "repo_map", "find_refs", "impact", "task", "memory_search", "web_search", "fetch_url", "todo_write", "tool_search", "skill", "finish"];

/** Write a short plan before touching any tool, then work as usual. Costs one extra model call per request. */
export function planFirst(o: { note?: string } = {}): Plugin {
  return { name: "strategy-plan-first", description: "plan in text first, then act", hooks: {
    PreModel: ({ step }) => (step === 0 ? { context: o.note ?? "Before you use any tool, write a short numbered plan (3 to 7 steps): what you will look at, what you will change, and how you will check it. Do not call tools in this reply.", tools: [], then: "Good. Now carry out the plan with the tools. Adjust it if you find something unexpected." } : undefined),
  } };
}

/** Two phases: look around with read-only tools for a few steps, then act. Stops the habit of editing before understanding. */
export function exploreThenAct(o: { readSteps?: number } = {}): Plugin {
  const n = Math.max(1, o.readSteps ?? 6);
  return { name: "strategy-explore-then-act", description: `read-only for the first ${n} steps, then edit`, hooks: {
    PreModel: ({ step }) => (step === 0 ? { context: `Work in two phases. Phase 1 (the next ${n} steps): you may only read and search; edits and shell commands are refused. Phase 2: you may change things. Use phase 1 to find where the change belongs.`, tools: READ_TOOLS }
      : (step as number) < n ? { tools: READ_TOOLS }
      : step === n ? { context: "Phase 2 starts now: you may edit files and run commands. Make the smallest correct change and verify it." } : undefined),
  } };
}

/**
 * Before finishing a task that points at a document ("as described in docs/SPEC.md", "follow the README"), make the model go through that document requirement by requirement.
 * Models often pass the visible tests and miss the edge cases a spec lists. It asks once, so it adds one round trip, not a loop.
 */
export function specCheck(): Plugin {
  return { name: "strategy-spec-check", description: "check the work against the document the task points to", gates: [{ name: "spec-check", maxRejections: 1, check: ({ task, cwd }) => {
    const named = [...new Set(task.match(/[\w./-]+\.(?:md|txt|rst|ya?ml|json|adoc)\b/gi) ?? [])].filter((f) => existsSync(resolve(cwd, f)));
    if (!named.length && !/\b(spec|specification|requirements?|as described|according to)\b/i.test(task)) return true;
    const where = named.length ? named.join(", ") : "the document or requirements the task refers to";
    return `Before you finish, open ${where} again and write its requirements as a numbered list (including edge cases, error cases and anything that says "must" or "always"). For each one say how you checked it: a test, or running the code. Fix whatever is not covered, then finish again.`;
  } }] };
}

export const STRATEGIES: Record<string, () => Plugin> = { "plan-first": () => planFirst(), "explore-then-act": () => exploreThenAct(), "spec-check": () => specCheck() };
export const strategyNames = () => Object.keys(STRATEGIES);

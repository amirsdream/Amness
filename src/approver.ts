// An optional second opinion on risky calls. Before the user is asked, a (cheaper) model reads the exact call and either approves it with a stated reason or passes it on to the user.
// It can only say yes to something that needs approval; it cannot say no, cannot touch the safety floor, and cannot clear a call whose text came from untrusted content. Any failure passes the call to the user.
import type { Approve, Message, Model } from "./harness.ts";

export type ReviewDecision = { decision: "approve" | "escalate"; reason: string };
const SYSTEM = `You review ONE tool call an autonomous coding agent wants to make, on behalf of the developer who owns the machine. Decide if it is clearly safe to run without asking them.
Approve only when ALL hold: it does what the task plausibly needs; it stays inside the project; it is easy to undo or only reads; it sends nothing off the machine; it deletes or overwrites nothing that was not just created.
Escalate (let the developer decide) for anything else, and whenever you are unsure. Network writes, publishing, installing global packages, credentials, deleting data, force operations, and anything you do not fully understand are always escalated.
Reply with JSON only: {"decision":"approve"|"escalate","reason":"<one short sentence>"}`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
export function parseDecision(text: string): ReviewDecision {
  const m = /\{[\s\S]*\}/.exec(text); if (!m) return { decision: "escalate", reason: "reviewer gave no verdict" };
  try { const j = JSON.parse(m[0]); return { decision: j.decision === "approve" ? "approve" : "escalate", reason: String(j.reason ?? "").slice(0, 200) || (j.decision === "approve" ? "judged safe" : "unsure") }; } catch { return { decision: "escalate", reason: "reviewer verdict was not valid JSON" }; }
}

/** Wrap `inner` (what asks the user) so a reviewer model gets the first look. `task` is the user's request, for context. */
export function reviewedApprove(inner: Approve, o: { model: Model; task?: () => string | undefined; onDecision?: (d: ReviewDecision & { tool: string }) => void; timeoutMs?: number }): Approve {
  return async (req) => {
    if (req.floor) return inner(req);                                               // the safety floor and untrusted-text policy always reach a human
    let d: ReviewDecision;
    try {
      const msgs: Message[] = [{ role: "system", content: SYSTEM }, { role: "user", content: `Developer's request: ${clip(o.task?.() ?? "(unknown)", 600)}\n\nTool: ${req.name}\nWhy it needs approval: ${req.reason ?? "(not stated)"}\nArguments: ${clip(JSON.stringify(req.args), 1500)}${req.preview ? `\nPreview:\n${clip(req.preview, 1500)}` : ""}` }];
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), o.timeoutMs ?? 20_000);
      try { d = parseDecision((await o.model(msgs, [], { signal: ac.signal })).content ?? ""); } finally { clearTimeout(t); }
    } catch { d = { decision: "escalate", reason: "reviewer unavailable" }; }
    o.onDecision?.({ ...d, tool: req.name });
    return d.decision === "approve" ? true : inner(req);
  };
}

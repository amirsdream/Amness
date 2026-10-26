import type { Event } from "../src/index.ts";
import { bold, cyan, dim, gray, green, magenta, red, yellow, blue } from "./ui.ts";

const one = (s: string, n = 90) => { const l = s.replace(/\s+/g, " ").trim(); return l.length > n ? l.slice(0, n - 1) + "…" : l; };
const argSummary = (name: string, raw: string) => {
  try {
    const a = JSON.parse(raw);
    return one(a.cmd ?? a.path ?? a.query ?? a.url ?? a.description ?? a.note ?? a.pattern ?? a.summary ?? raw, 80);
  } catch { return one(raw, 80); }
};
const agentColor = (name: string) => ({ lead: cyan, general: magenta }[name] ?? blue)(name.padEnd(7));

/** One readable trace line per harness event. */
export function formatEvent(e: Event & { agent?: string }): string {
  const who = e.agent ? agentColor(e.agent) + " " : "";
  switch (e.kind) {
    case "tool": {
      const bad = /^(ERROR|DENIED|REJECTED)/.test(e.result) || /^exit=[^0]/.test(e.result);
      return `${who}${bad ? red("✗") : green("✓")} ${e.name} ${dim(argSummary(e.name, e.args))}${bad ? "  " + red(one(e.result, 70)) : ""}`;
    }
    case "nudge": return `${who}${yellow("↻ nudge")} ${dim("model described an action instead of doing it → told to act")}`;
    case "repair": return `${who}${yellow("⚒ repair")} ${dim("invalid tool call → error returned to model: " + one(e.detail, 70))}`;
    case "loop": return `${who}${yellow("∞ loop guard")} ${dim("repeated identical call refused")}`;
    case "rejected": return `${who}${yellow("⛔ finish rejected")} ${dim(one(e.detail, 80))}`;
    case "denied": return `${who}${red("⊘ denied")} ${dim(e.detail)}`;
    case "budget": return `${who}${red("$ budget")} ${e.detail}`;
    case "tools": return `${who}${gray("⚙ toolbox changed")} ${dim(one(e.detail, 70))}`;
    case "edit": {
      const body = e.diff.split("\n").filter((l) => !/^(---|\+\+\+)/.test(l));
      const shown = body.slice(0, 40).map((l) => l.startsWith("+") ? green("    " + l) : l.startsWith("-") ? red("    " + l) : l.startsWith("@@") ? cyan("    " + l) : gray("    " + l));
      if (body.length > 40) shown.push(dim(`    … ${body.length - 40} more lines`));
      return `${who}${yellow("✎")} ${bold(e.path)} ${e.created ? green("new file ") : ""}${green("+" + e.added)} ${red("-" + e.removed)}\n${shown.join("\n")}`;
    }
    case "aborted": return `${who}${yellow("⏹ stopped")} ${dim("run interrupted; progress is saved and can be resumed")}`;
    case "turn": case "toolstart": case "text": case "thinking": case "assistant": case "todos": case "steer": return "";
    case "rollover": return `${who}${magenta("⟳ context rollover")} ${dim("handoff note written; continuing in a fresh context")}`;
    case "finish": return `${who}${green("✔ finish")} ${dim(one(e.summary, 80))}`;
  }
}

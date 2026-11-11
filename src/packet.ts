// The handoff packet: what a model starts from when it takes over mid-task (an advisor, a higher tier after an escalation, a lower tier
// after stepping down), instead of the whole transcript. Re-sending a transcript to another model pays a cold read every time, does not fit
// a small window, and is the cost none of the escalation papers model; a packet is small, and the user's rules travel in it word for word.
import { clip, pinRules, type Message } from "./harness.ts";
import { mechanicalNote } from "./context.ts";

export type PacketInput = {
  messages: Message[];
  /** why this model is being handed the work */ why: string;
  /** a handoff note written by a model, when there is one (else one is written from the tool calls) */ note?: string;
  /** files changed and notes from the claims ledger */ changed?: string[]; auditNotes?: string[];
  /** the current diff (capped here) */ diff?: string;
  /** a question for the new model */ question?: string;
  /** total size cap in characters (default 20,000); the task and the rules are never cut below their own caps */ cap?: number;
};

/** The packet as one text. Sections in a fixed order; the rules are kept word for word. */
export function buildPacket(i: PacketInput): string {
  const userTexts = i.messages.filter((m) => m.role === "user").map((m) => m.content ?? ""), task = userTexts[0] ?? "";
  const rules = pinRules(userTexts.slice(1));
  const lastFail = [...i.messages].reverse().find((m) => m.role === "tool" && /^(ERROR|exit=[1-9])|\bFAIL|Error:/m.test(m.content ?? ""))?.content;
  const cap = i.cap ?? 20_000, fixed = [`WHY YOU ARE GIVEN THIS: ${i.why}`, i.question && `QUESTION: ${clip(i.question, 1500)}`, `TASK:\n${clip(task, 4000)}`, rules.length ? `RULES FROM THE USER (word for word):\n${rules.join("\n")}` : ""].filter(Boolean) as string[];
  const room = Math.max(2000, cap - fixed.join("\n\n").length);
  const flexible = [`WORK SO FAR:\n${clip(i.note ?? mechanicalNote(i.messages), Math.round(room * 0.3))}`,
    `FILES CHANGED: ${i.changed?.join(", ") || "none"}${i.auditNotes?.length ? `\n${i.auditNotes.join("\n")}` : ""}`,
    i.diff?.trim() && `DIFF:\n${clip(i.diff, Math.round(room * 0.45))}`, lastFail && `LAST FAILURE:\n${clip(lastFail, Math.round(room * 0.15))}`].filter(Boolean) as string[];
  return clip([...fixed, ...flexible].join("\n\n"), cap + 4000);
}

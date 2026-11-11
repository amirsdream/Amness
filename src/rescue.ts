// Tool calls written as text. Some local models (and some chat templates) put a call in the reply's text instead of the structured
// tool_calls field; the harness then sees prose and nudges, and the call is lost. These are the shapes seen in the wild:
//   <tool_call>{"name": "read_file", "arguments": {...}}</tool_call>            (Hermes / Qwen templates)
//   <function=read_file>{"path": "a"}</function>                               (Llama-style)
//   <function=read_file><parameter=path>a</parameter></function>               (Qwen3-Coder XML)
//   [TOOL_CALLS] [{"name": "read_file", "arguments": {...}}]                   (Mistral)
//   <|python_tag|>{"name": "read_file", "parameters": {...}}                   (Llama 3.1)
//   ```json {"name": "read_file", "arguments": {...}} ```  or the same object bare
// A local-first harness rescues such calls rather than rejecting them (Mingbird, arXiv 2610.02001, read); a ladder study scores them as
// failures (AgentFloor, arXiv 2605.00334, read). So this is opt-in per model, and every rescue is counted.

export type TextCall = { name: string; args: string; /** where the call is in the text, to cut it out */ start: number; end: number; shape: string };

/** Every candidate call in `text`, in order. Candidates are not checked against the tool list here; the caller does that. */
export function findTextCalls(text: string): TextCall[] {
  const out: TextCall[] = [];
  const taken = (s: number, e: number) => out.some((c) => s < c.end && e > c.start);
  const fromObject = (obj: unknown): { name: string; args: string } | undefined => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const o = obj as Record<string, unknown>, fn = (o.function && typeof o.function === "object" ? o.function : o) as Record<string, unknown>;
    const name = fn.name, a = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input;
    if (typeof name !== "string" || !name.trim()) return undefined;
    if (a !== undefined && (typeof a !== "object" || a === null || Array.isArray(a)) && typeof a !== "string") return undefined;
    return { name: name.trim(), args: typeof a === "string" ? a : JSON.stringify(a ?? {}) };
  };
  const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
  const push = (shape: string, start: number, end: number, body: string) => {
    if (taken(start, end)) return;
    const j = tryJson(body.trim()), list = Array.isArray(j) ? j : [j];
    for (const x of list) { const c = fromObject(x); if (c) out.push({ ...c, start, end, shape }); }
  };
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) push("tool_call tag", m.index!, m.index! + m[0].length, m[1]);
  for (const m of text.matchAll(/<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g)) {
    const s = m.index!, e = s + m[0].length; if (taken(s, e)) continue;
    const body = m[2], params = [...body.matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)];
    if (params.length) out.push({ name: m[1], args: JSON.stringify(Object.fromEntries(params.map((p) => [p[1], (() => { const v = tryJson(p[2]); return v !== undefined && typeof v !== "string" ? v : p[2]; })()]))), start: s, end: e, shape: "function tag" });
    else if (!body.trim() || tryJson(body.trim()) !== undefined) out.push({ name: m[1], args: body.trim() || "{}", start: s, end: e, shape: "function tag" });
  }
  for (const m of text.matchAll(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g)) push("TOOL_CALLS", m.index!, m.index! + m[0].length, m[1]);
  for (const m of text.matchAll(/<\|python_tag\|>\s*(\{[\s\S]*\})/g)) push("python_tag", m.index!, m.index! + m[0].length, m[1]);
  for (const m of text.matchAll(/```(?:json|tool_call)?\s*\n?([\s\S]*?)```/g)) push("fenced JSON", m.index!, m.index! + m[0].length, m[1]);
  // A bare object: only when the whole reply (or a whole line block) is the object, so JSON quoted inside an explanation is left alone.
  const bare = text.trim();
  if (!out.length && bare.startsWith("{") && bare.endsWith("}")) push("bare JSON", text.indexOf(bare), text.indexOf(bare) + bare.length, bare);
  return out.sort((a, b) => a.start - b.start);
}

/** The text with the given calls cut out (and the whitespace they leave tidied). */
export function withoutCalls(text: string, calls: TextCall[]): string {
  let out = "", at = 0;
  for (const c of [...calls].sort((a, b) => a.start - b.start)) { out += text.slice(at, c.start); at = c.end; }
  return (out + text.slice(at)).replace(/\n{3,}/g, "\n\n").trim();
}

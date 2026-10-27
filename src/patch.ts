// Multi-file patches. Two input formats are accepted so models can use whichever they know best:
//   the envelope used by Codex ("*** Begin Patch / *** Update File: x / @@ / -old / +new / *** End Patch") and ordinary unified diffs.
// Application is all-or-nothing: every hunk of every file must apply, or nothing is written and each failure is reported by name.
export type Line = { t: " " | "-" | "+"; s: string };
export type Hunk = { anchor?: string; lines: Line[]; /** line number hint from a unified diff (1-based) */ hint?: number };
export type FileOp = { path: string; op: "update" | "add" | "delete"; moveTo?: string; hunks: Hunk[] };

const strip = (p: string) => p.replace(/^\s+|\s+$/g, "").replace(/^"|"$/g, "").replace(/^[ab]\//, "");

export function parsePatch(text: string): FileOp[] {
  const L = text.replace(/\r\n/g, "\n").split("\n");
  return L.some((l) => l.startsWith("*** Begin Patch") || /^\*\*\* (Update|Add|Delete) File:/.test(l)) ? parseEnvelope(L) : parseUnified(L);
}

function parseEnvelope(L: string[]): FileOp[] {
  const ops: FileOp[] = []; let cur: FileOp | undefined, hunk: Hunk | undefined;
  const flush = () => { if (cur && hunk && hunk.lines.length) cur.hunks.push(hunk); hunk = undefined; };
  for (const l of L) {
    let m: RegExpExecArray | null;
    if (l.startsWith("*** Begin Patch") || l.startsWith("*** End Patch") || l.startsWith("*** End of File")) { flush(); if (l.startsWith("*** End Patch")) break; continue; }
    if ((m = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/.exec(l))) { flush(); cur = { path: strip(m[2]), op: m[1].toLowerCase() as FileOp["op"], hunks: [] }; ops.push(cur); continue; }
    if (!cur) continue;
    if ((m = /^\*\*\* Move to:\s*(.+)$/.exec(l))) { cur.moveTo = strip(m[1]); continue; }
    if (l.startsWith("@@")) { flush(); hunk = { anchor: l.slice(2).trim() || undefined, lines: [] }; continue; }
    if (cur.op === "delete") continue;
    const c = l[0];
    if (c === "+" || c === "-" || c === " " || l === "") { hunk ??= { lines: [] }; hunk.lines.push({ t: (c === "+" || c === "-" ? c : " ") as Line["t"], s: l === "" ? "" : l.slice(1) }); }
  }
  flush();
  for (const o of ops) if (o.op === "add") { const all = o.hunks.flatMap((h) => h.lines.map((x) => x.s)); o.hunks = [{ lines: all.map((s) => ({ t: "+" as const, s })) }]; }
  return ops;
}

function parseUnified(L: string[]): FileOp[] {
  const ops: FileOp[] = []; let cur: FileOp | undefined, hunk: Hunk | undefined, from = "";
  const flush = () => { if (hunk) { while (hunk.lines.length && hunk.lines.at(-1)!.t === " " && hunk.lines.at(-1)!.s === "") hunk.lines.pop(); } if (cur && hunk && hunk.lines.length) cur.hunks.push(hunk); hunk = undefined; };   // the blank line after the last newline is not context
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (l.startsWith("--- ") && L[i + 1]?.startsWith("+++ ")) {
      flush(); from = l.slice(4).split("\t")[0]; const to = L[++i].slice(4).split("\t")[0];
      const add = /^\/dev\/null/.test(from), del = /^\/dev\/null/.test(to);
      cur = { path: strip(del ? from : to), op: add ? "add" : del ? "delete" : "update", hunks: [] }; ops.push(cur); continue;
    }
    if (!cur) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@\s*(.*)$/.exec(l);
    if (h) { flush(); hunk = { hint: Number(h[1]), anchor: h[2] || undefined, lines: [] }; continue; }
    if (!hunk || l.startsWith("\\")) continue;
    const c = l[0]; if (c === "+" || c === "-" || c === " ") hunk.lines.push({ t: c, s: l.slice(1) }); else if (l === "") hunk.lines.push({ t: " ", s: "" });
  }
  flush();
  return ops;
}

/** Every path a patch touches (for permission checks). */
export function patchPaths(text: string): string[] { try { return [...new Set(parsePatch(text).flatMap((o) => [o.path, ...(o.moveTo ? [o.moveTo] : [])]))]; } catch { return []; } }

const same = (a: string, b: string) => a === b || a.trimEnd() === b.trimEnd();
const loose = (a: string, b: string) => a.trim() === b.trim();
/** First index >= from where `seq` matches the file lines (exactly, then ignoring trailing space, then ignoring indentation). */
function find(file: string[], seq: string[], from: number): { at: number; fuzzy: boolean } | undefined {
  if (!seq.length) return { at: Math.min(from, file.length), fuzzy: false };
  for (const [eq, fuzzy] of [[(a: string, b: string) => a === b, false], [same, false], [loose, true]] as const) {
    for (let i = from; i + seq.length <= file.length; i++) { let ok = true; for (let j = 0; j < seq.length && ok; j++) ok = eq(file[i + j], seq[j]); if (ok) return { at: i, fuzzy }; }
  }
  return undefined;
}
/** Re-indent replacement lines when the match was found ignoring indentation: shift by the difference in leading whitespace of the first matched line. */
function reindent(newLines: string[], oldFirst: string, fileFirst: string): string[] {
  const lead = (s: string) => /^\s*/.exec(s)![0], a = lead(oldFirst), b = lead(fileFirst);
  if (a === b) return newLines;
  return newLines.map((l) => (l.trim() === "" ? l : l.startsWith(a) ? b + l.slice(a.length) : l));
}

export type Applied = { path: string; before: string | null; after: string | null; fuzzy: number };
export function applyOps(ops: FileOp[], read: (path: string) => string | undefined): { applied: Applied[]; errors: string[] } {
  const applied: Applied[] = [], errors: string[] = [], seen = new Set<string>();
  for (const o of ops) {
    if (seen.has(o.path)) { errors.push(`${o.path}: appears twice in the patch; put all its hunks under one heading`); continue; } seen.add(o.path);
    const before = read(o.path);
    if (o.op === "add") { if (before !== undefined) errors.push(`${o.path}: cannot add, the file already exists (use Update File)`); else applied.push({ path: o.path, before: null, after: o.hunks.flatMap((h) => h.lines.map((x) => x.s)).join("\n") + "\n", fuzzy: 0 }); continue; }
    if (before === undefined) { errors.push(`${o.path}: no such file`); continue; }
    if (o.op === "delete") { applied.push({ path: o.path, before, after: null, fuzzy: 0 }); continue; }
    const trailing = before.endsWith("\n"), file = before.split("\n"); if (trailing) file.pop();
    let cursor = 0, fuzzy = 0, bad = false;
    o.hunks.forEach((h, hi) => {
      if (bad) return;
      const oldSeq = h.lines.filter((x) => x.t !== "+").map((x) => x.s), newSeq = h.lines.filter((x) => x.t !== "-").map((x) => x.s);
      let from = cursor;
      if (h.anchor) { const a = find(file, [h.anchor], cursor); if (a) from = a.at; }                        // "@@ function name" narrows where to look
      else if (h.hint && h.hint - 1 >= cursor && h.hint - 1 <= file.length) { const near = find(file, oldSeq, Math.max(cursor, h.hint - 1 - 3)); if (near && near.at <= h.hint - 1 + 3) from = near.at; }
      const m = find(file, oldSeq, from) ?? (from > cursor ? find(file, oldSeq, cursor) : undefined);
      if (!m) { errors.push(`${o.path}, hunk ${hi + 1}: the lines to replace were not found${h.anchor ? ` after "${h.anchor}"` : ""}. First line looked for: ${JSON.stringify(oldSeq.find((s) => s.trim()) ?? oldSeq[0] ?? "")}`); bad = true; return; }
      if (m.fuzzy) fuzzy++;
      file.splice(m.at, oldSeq.length, ...(m.fuzzy ? reindent(newSeq, oldSeq[0] ?? "", file[m.at] ?? "") : newSeq));
      cursor = m.at + newSeq.length;
    });
    if (!bad) applied.push({ path: o.moveTo ?? o.path, before, after: file.join("\n") + (trailing ? "\n" : ""), fuzzy });
    if (!bad && o.moveTo && o.moveTo !== o.path) applied.push({ path: o.path, before, after: null, fuzzy: 0 });
  }
  return { applied: errors.length ? [] : applied, errors };
}

/** Replace `old` by `nw` in `content`: exactly once. When there is no exact match and `old` spans whole lines, a match that differs only in indentation or trailing space is accepted if it is unique (and reported). */
export function replaceOnce(content: string, old: string, nw: string): { out: string; fuzzy?: boolean } | { error: string } {
  if (!old) return { error: "`old` is empty" };
  const n = content.split(old).length - 1;
  if (n === 1) return { out: content.replace(old, () => nw) };
  if (n > 1) return { error: `\`old\` matched ${n} times; it must match exactly once. Include more surrounding lines.` };
  const oldLines = old.replace(/\n$/, "").split("\n"), file = content.split("\n"), hits: number[] = [];
  if (oldLines.length >= 1 && (oldLines.length > 1 || oldLines[0].trim() === (file.find((l) => l.trim() === oldLines[0].trim()) ?? "\0").trim()))
    for (let i = 0; i + oldLines.length <= file.length; i++) { let ok = true; for (let j = 0; j < oldLines.length && ok; j++) ok = file[i + j].trim() === oldLines[j].trim(); if (ok) hits.push(i); }
  if (hits.length === 1) { const rep = reindent(nw.replace(/\n$/, "").split("\n"), oldLines[0], file[hits[0]]); file.splice(hits[0], oldLines.length, ...rep); return { out: file.join("\n"), fuzzy: true }; }
  return { error: hits.length > 1 ? `\`old\` did not match exactly, and ${hits.length} places match ignoring indentation; include more surrounding lines.` : "`old` was not found in the file (check the exact text, including indentation; read the file again if it may have changed)." };
}
/** Apply several edits in order to one file's text; all-or-nothing. */
export function replaceMany(content: string, edits: { old: string; new: string }[]): { out: string; fuzzy: number } | { error: string } {
  let cur = content, fuzzy = 0;
  for (const [i, e] of edits.entries()) { const r = replaceOnce(cur, e.old, e.new); if ("error" in r) return { error: `edit ${i + 1} of ${edits.length}: ${r.error}` }; cur = r.out; if (r.fuzzy) fuzzy++; }
  return { out: cur, fuzzy };
}

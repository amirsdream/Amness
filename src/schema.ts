/** Minimal JSON-schema subset: type, enum, required, properties, additionalProperties, items. Returns error strings. */
export type Schema = {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  description?: string;
};

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function validate(v: unknown, s: Schema, path = "$"): string[] {
  const errs: string[] = [];
  const t = typeOf(v);
  if (s.type && !(t === s.type || (s.type === "integer" && Number.isInteger(v)) || (s.type === "number" && t === "number")))
    return [`${path}: expected ${s.type}, got ${t}`];
  if (s.enum && !s.enum.includes(v)) errs.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  if (t === "object") {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) errs.push(`${path}.${k}: required`);
    for (const [k, x] of Object.entries(o)) {
      if (s.properties?.[k]) errs.push(...validate(x, s.properties[k], `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}.${k}: unexpected property`);
    }
  }
  if (t === "array" && s.items) (v as unknown[]).forEach((x, i) => errs.push(...validate(x, s.items!, `${path}[${i}]`)));
  return errs;
}

/** Parse JSON the way models actually emit it: strip ``` fences and surrounding prose. */
export function parseLooseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch { /* fall through to brace scan */ }
  const i = t.search(/[{[]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error("no JSON found");
}

/**
 * Parse tool-call arguments the way weak and local models send them. Strict JSON first, then the loose
 * parser, then small repairs: trailing commas, single-quoted strings, raw newlines inside strings, a JSON
 * string that holds the object, and the object wrapped as {"arguments": ...} or {"parameters": ...}.
 * Returns the value and what was repaired, or an error when nothing gives an object.
 */
export function parseArgs(raw: string): { args: Record<string, unknown>; fixes: string[] } | { error: string } {
  const fixes: string[] = [];
  const src = (raw ?? "").trim() || "{}";
  let v: unknown, first: string | undefined;
  try { v = JSON.parse(src); } catch (e) { first = (e as Error).message; }
  if (first !== undefined) {
    const tries: [string, () => unknown][] = [
      ["extra text around the JSON", () => parseLooseJson(src)],
      ["trailing commas", () => parseLooseJson(src.replace(/,\s*([}\]])/g, "$1"))],
      ["raw line breaks inside strings", () => parseLooseJson(escapeNewlinesInStrings(src.replace(/,\s*([}\]])/g, "$1")))],
      ["single quotes", () => parseLooseJson(singleToDouble(src.replace(/,\s*([}\]])/g, "$1")))],
    ];
    for (const [what, f] of tries) { try { v = f(); fixes.push(what); break; } catch { /* next */ } }
    if (!fixes.length) return { error: first };
  }
  if (typeof v === "string") { try { const inner = JSON.parse(v); if (inner && typeof inner === "object") { v = inner; fixes.push("the object was sent as a JSON string"); } } catch { /* a plain string */ } }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && (keys[0] === "arguments" || keys[0] === "parameters" || keys[0] === "args")) {
      let inner = (v as Record<string, unknown>)[keys[0]];
      if (typeof inner === "string") { try { inner = JSON.parse(inner); } catch { /* leave */ } }
      if (inner && typeof inner === "object" && !Array.isArray(inner)) { v = inner; fixes.push(`unwrapped from "${keys[0]}"`); }
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `expected a JSON object, got ${typeOf(v)}` };
  return { args: v as Record<string, unknown>, fixes };
}

function escapeNewlinesInStrings(s: string): string {
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (inStr && !esc && (ch === "\n" || ch === "\r" || ch === "\t")) { out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t"; continue; }
    if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = !inStr;
    out += ch;
  }
  return out;
}

function singleToDouble(s: string): string {
  let out = "", q: string | null = null, esc = false;
  for (const ch of s) {
    if (q) {
      if (esc) { out += ch === "'" ? "'" : "\\" + ch; esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === q) { out += '"'; q = null; continue; }
      out += ch === '"' && q === "'" ? '\\"' : ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; out += '"'; continue; }
    out += ch;
  }
  return out;
}

/**
 * Coerce a value toward a schema without changing its meaning: numeric strings to numbers, "true"/"false"
 * to booleans, a JSON string to the object or array the schema wants, a scalar to a one-item array, and an
 * optional property sent as null removed. Missing required values are never guessed. Returns the new value
 * and one line per change.
 */
export function coerce(v: unknown, s: Schema, path = "$"): { value: unknown; fixes: string[] } {
  const fixes: string[] = [];
  const go = (x: unknown, sc: Schema, p: string): unknown => {
    let t = typeOf(x);
    if (sc.type && t === "string" && (sc.type === "object" || sc.type === "array")) {
      try { const j = JSON.parse(x as string); if (typeOf(j) === sc.type) { fixes.push(`${p}: parsed the ${sc.type} sent as a string`); x = j; t = sc.type; } } catch { /* not JSON */ }
    }
    if ((sc.type === "number" || sc.type === "integer") && t === "string" && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(x as string)) {
      const n = Number(x); if (sc.type === "number" || Number.isInteger(n)) { fixes.push(`${p}: "${x}" → ${n}`); return n; }
    }
    if (sc.type === "boolean" && t === "string" && /^(true|false)$/i.test((x as string).trim())) { const b = (x as string).trim().toLowerCase() === "true"; fixes.push(`${p}: "${x}" → ${b}`); return b; }
    if (sc.type === "array" && t !== "array" && t !== "null" && x !== undefined) {
      const item = sc.items ? go(x, sc.items, `${p}[0]`) : x;
      if (!sc.items || validate(item, sc.items).length === 0) { fixes.push(`${p}: one value wrapped in a list`); return [item]; }
    }
    if (t === "array" && sc.items) return (x as unknown[]).map((y, i) => go(y, sc.items!, `${p}[${i}]`));
    if (t === "object" && sc.properties) {
      const o = { ...(x as Record<string, unknown>) }, req = new Set(sc.required ?? []);
      for (const [k, y] of Object.entries(o)) {
        if (!sc.properties[k]) continue;
        if (y === null && !req.has(k) && sc.properties[k].type !== "null") { delete o[k]; fixes.push(`${p}.${k}: null dropped (optional)`); continue; }
        o[k] = go(y, sc.properties[k], `${p}.${k}`);
      }
      return o;
    }
    return x;
  };
  const value = go(v, s, path);
  return { value, fixes };
}

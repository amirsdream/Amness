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

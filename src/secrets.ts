// Secrets must not travel to the model provider or into traces. Known token formats and assignments that look like credentials are masked in tool output before the model sees it.
export type Redacted = { text: string; count: number; kinds: string[] };

const PATTERNS: [string, RegExp][] = [
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g], ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/g], ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g], ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g], ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g], ["stripe-key", /\b[rs]k_(?:live|test)_[0-9a-zA-Z]{20,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g], ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g], ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];
/** `PASSWORD=hunter2hunter2`, `"api_key": "abcd1234efgh"`, `Authorization: Bearer xyz...` : keep the name, mask the value. */
const ASSIGN = /((?:^|[\s"'`{,])(?:[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*["'`]?)([^\s"'`,;}{]{8,})/gi;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g;

export function redact(text: string): Redacted {
  let count = 0; const kinds = new Set<string>(); let out = text;
  for (const [kind, re] of PATTERNS) out = out.replace(re, () => { count++; kinds.add(kind); return `[REDACTED:${kind}]`; });
  out = out.replace(BEARER, (_m, pre) => { count++; kinds.add("bearer-token"); return `${pre}[REDACTED:bearer-token]`; });
  out = out.replace(ASSIGN, (m, pre: string, val: string) => { if (/^\[REDACTED|^\$\{?\w+\}?$|^<[^>]+>$|^(?:true|false|null|undefined|none)$/i.test(val) || /^(?:process\.env|os\.environ|getenv|ENV\[)/.test(val)) return m; count++; kinds.add("credential-assignment"); return `${pre}[REDACTED:credential]`; });
  return { text: out, count, kinds: [...kinds] };
}

/** `redact` applied to every string inside a JSON-like value (used before anything is written to a trace). */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v).text as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

/** Environment variables a command run by the agent should not inherit: Amness's own keys always; with `strict`, anything that looks like a credential. */
export function childEnv(env: NodeJS.ProcessEnv = process.env, strict = false): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(OPENAI_API_KEY|ANTHROPIC_API_KEY|TAVILY_API_KEY|OPENROUTER_API_KEY|AMNESS_[A-Z_]*KEY|AMNESS_OTLP)$/.test(k)) continue;
    if (strict && /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(k) && !/^(SSH_AUTH_SOCK|GPG_TTY|KEYCHAIN.*|DISPLAY)$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

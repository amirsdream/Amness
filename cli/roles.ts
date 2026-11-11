// Model references and role wiring, shared by the chat app (TUI and desktop) and `amness run`, so the two cannot drift apart.
// A reference names a model on any connected provider or saved server, each with its own address and key:
//   anthropic:claude-haiku-5-5   openai:<id>   openrouter:<id>   ollama:<id>   custom:<id>   (a provider and a model)
//   anthropic/claude-haiku-5-5   (the same, in the form `amness tune --models` and the Harbor adapter use)
//   server:lab   server:lab/qwen3-8b   lab   (a saved server and its saved model, or another model on it)
//   gpt-6-luna   (a bare id: the main provider and server)
import type { Model, ModelCard, Roles, ModelTier } from "../src/index.ts";
import { ladderModel, loadProfile, routedModel, withCard, withFallback, type LadderModel } from "../src/index.ts";
import { PROVIDERS, keyFor, serverKey, windowFor, type Config, type ProviderId } from "./config.ts";
import { priceOf } from "./tui/pricing.ts";

export const ROLE_NAMES = ["explore", "compact", "review", "cheap", "approve", "quarantine", "advisor"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** The config a reference stands for, without creating a model. Throws a clear error, listing what is connected, when it names nothing. */
export function resolveConfig(ref: string, cfg: Config): { config: Config; name: string; label: string } {
  const out = resolveRaw(ref, cfg);
  // A role model never carries roles of its own (no advisor tool, no fallback, no router on it); the main config itself is returned as is.
  return out.config === cfg ? out : { ...out, config: { ...out.config, models: undefined, fallback: undefined, router: undefined } };
}
function resolveRaw(ref: string, cfg: Config): { config: Config; name: string; label: string } {
  const r = ref.trim();
  if (!r) throw new Error("empty model reference");
  const servers = cfg.servers ?? [];
  const sm = /^server:([^/]+)(?:\/(.+))?$/.exec(r);
  const saved = sm ? servers.find((s) => s.name === sm[1]) : servers.find((s) => s.name === r);
  if (sm && !saved) throw new Error(`no saved server named "${sm[1]}". ${connected(cfg)}`);
  if (saved) {
    const model = sm?.[2] ?? saved.model;
    // A saved server's own key only: never the main provider's, never the environment's OPENAI_API_KEY meant for someone else.
    const config: Config = { ...cfg, provider: saved.provider, baseUrl: saved.baseUrl, model, server: saved.name, apiKey: keyFor(serverKey(saved.name)).key, contextWindow: undefined };
    return { config, name: model, label: `server:${saved.name}/${model}` };
  }
  const pm = /^([a-z]+)[:/](.+)$/.exec(r);
  if (pm && pm[1] in PROVIDERS && !(pm[0].includes("/") && !pm[0].includes(":") && cfg.provider === "openrouter" && pm[1] !== "openrouter")) {
    const p = pm[1] as ProviderId, model = pm[2];
    if (p === cfg.provider && !cfg.server) return { config: { ...cfg, model }, name: model, label: `${p}:${model}` };
    const config: Config = { ...cfg, provider: p, baseUrl: PROVIDERS[p].baseUrl, model, server: undefined, apiKey: keyFor(p).key, contextWindow: undefined };
    return { config, name: model, label: `${p}:${model}` };
  }
  // Another model on the main provider: the main model's own window setting does not apply to it (its learned window, if any, still does).
  return { config: r === cfg.model ? cfg : { ...cfg, model: r, contextWindow: undefined }, name: r, label: r };
}

/** A first guess at a model's tier when no profile says: models on your own servers are local, small hosted families mid, the rest frontier. */
export function guessTier(c: Pick<Config, "provider" | "model" | "baseUrl">): ModelTier {
  const official = /api\.(openai|anthropic)\.com|openrouter\.ai/.test(c.baseUrl);
  if (c.provider === "ollama" || (c.provider === "custom" && !official)) return "local";
  if (/haiku|mini|nano|luna|flash|small|lite/i.test(c.model)) return "mid";
  return "frontier";
}

/** The card for a model built from a config: its own id, window and profile (the profile file is read for this model id, not the main one). */
export function cardFor(c: Config, cwd: string): ModelCard {
  let profile: ModelCard["profile"] = {}, tier: ModelTier | undefined, textCalls: boolean | undefined, cacheFactor: number | undefined;
  try { const p = loadProfile(cwd, c.model).profile; tier = p.tier; textCalls = p.textToolCalls; cacheFactor = p.cacheFactor; profile = { toolChoice: p.toolChoice, thinkingBudget: p.thinkingBudget, keepThinking: p.keepThinking, request: p.request, off: p.off, stagnationTurns: p.stagnationTurns, maxSteps: p.maxSteps, contextBudget: p.contextBudget, tools: p.tools }; } catch { /* a broken profile is reported by the caller for the main model */ }
  return { id: c.model, provider: c.server ? `server:${c.server}` : c.provider, window: () => windowFor(c), profile, tier: tier ?? guessTier(c), tierFrom: tier ? "profile" : "guess", ...(cacheFactor !== undefined && { cacheFactor }), ...(textCalls !== undefined && { caps: { textToolCalls: textCalls } }) };
}

/** What can be named, for error messages and completion. */
export function connected(cfg: Config): string {
  const provs = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => p === cfg.provider || keyFor(p).key || !PROVIDERS[p].needsKey);
  const servers = (cfg.servers ?? []).map((s) => `server:${s.name}`);
  return `Use a bare model id (main provider ${cfg.provider}), provider:model (${provs.join(", ")}), or a saved server (${servers.join(", ") || "none saved"}).`;
}

/** All references worth offering in completion: each saved server, and each connected provider with its default model. */
export function referenceOptions(cfg: Config): string[] {
  const out = (cfg.servers ?? []).map((s) => `server:${s.name}`);
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) if (p !== "custom" && (p === cfg.provider || keyFor(p).key)) out.push(`${p}:${PROVIDERS[p].model}`);
  return [...new Set(out)];
}

/** True when two configs reach the same model at the same place. */
const sameModel = (a: Config, b: Config) => a.provider === b.provider && a.baseUrl === b.baseUrl && a.model === b.model && (a.server ?? "") === (b.server ?? "");

export type Wired = {
  /** The main model with fallback and the router applied. */
  model: Model;
  roles: Roles;
  /** Role name → reference label, for /status, the sidebar and the --json config line. Only roles that differ from the main model. */
  labels: Partial<Record<RoleName | "fallback" | "ladder", string>>;
  /** Models for other uses by reference (plugin `route`, custom agents' `model:` key, eval `model:` variants). */
  byRef: (ref: string) => Model;
  /** The approval reviewer's and the quarantine reader's own models, when set. */
  approve?: Model; quarantine?: Model; advisor?: Model;
  /** The recovery ladder, when `ladder` is set: then it is also `model`. */
  ladder?: LadderModel;
};

/**
 * Build the main model and every role from the config. `make` turns a config into a model (the caller adds caching, spinners, cache keys).
 * Fallback: retryable errors on the main model answer from `cfg.fallback`. Router: exploration steps go to `models.cheap` when that pays off.
 */
export function wireModels(cfg: Config, mainRaw: Model, makeRaw: (c: Config) => Model, hooks: { onFallback?: () => void; onRoute?: (d: { tier: "strong" | "cheap"; switched: boolean; reason: string }, label: string) => void; /** attach model cards (each model's own window and profile) read from this project */ cwd?: string } = {}): Wired {
  const cache = new Map<string, Model>(), labels: Wired["labels"] = {};
  const carded = (m: Model, c: Config) => (hooks.cwd ? withCard(m, cardFor(c, hooks.cwd)) : m);
  const main = carded(mainRaw, cfg), make = (c: Config) => carded(makeRaw(c), c);
  const byRef = (ref: string): Model => {
    const r = resolveConfig(ref, cfg);
    if (sameModel(r.config, cfg)) return main;
    const k = `${r.config.provider}|${r.config.baseUrl}|${r.config.server ?? ""}|${r.config.model}`;
    let m = cache.get(k); if (!m) { m = make(r.config); cache.set(k, m); }
    return m;
  };
  const role = (name: RoleName | "fallback", ref?: string): Model | undefined => {
    if (!ref) return undefined;
    const r = resolveConfig(ref, cfg); if (sameModel(r.config, cfg)) return undefined;
    labels[name] = r.label; return byRef(ref);
  };
  const m = cfg.models ?? {};
  if (cfg.ladder?.length) {
    // The ladder replaces the main model, the fallback and the router: it decides which tier answers.
    const tiers = cfg.ladder.map((ref) => ({ model: byRef(ref), label: resolveConfig(ref, cfg).label }));
    const lad = ladderModel(tiers, cfg.ladderStart ?? 0);
    const m = cfg.models ?? {};
    return { model: lad, ladder: lad, roles: { explore: role("explore", m.explore), compact: role("compact", m.compact), review: role("review", m.review) }, labels: { ...labels, ladder: tiers.map((t) => t.label).join(" → ") } as Wired["labels"], byRef, approve: role("approve", m.approve), quarantine: role("quarantine", m.quarantine), advisor: role("advisor", m.advisor) };
  }
  const fb = role("fallback", cfg.fallback);
  let model = fb ? withFallback(main, fb, () => hooks.onFallback?.()) : main;
  const roles: Roles = { explore: role("explore", m.explore), compact: role("compact", m.compact), review: role("review", m.review), cheap: role("cheap", m.cheap) };
  if (cfg.router && roles.cheap) {
    const cheapCfg = resolveConfig(m.cheap!, cfg).config, pm = priceOf(cfg.model), pc = priceOf(cheapCfg.model);
    const cheapLabel = labels.cheap ?? m.cheap!;
    model = routedModel({ strong: model, cheap: roles.cheap, prices: pm && pc ? { strong: { input: pm[1], output: pm[2] }, cheap: { input: pc[1], output: pc[2] } } : undefined,
      onRoute: (d) => hooks.onRoute?.(d, d.tier === "cheap" ? cheapLabel : cfg.model) });
  }
  return { model, roles, labels, byRef, approve: role("approve", m.approve), quarantine: role("quarantine", m.quarantine), advisor: role("advisor", m.advisor) };
}

// The model card: what a model is and how it wants to be called, carried by the model itself.
// Before, the window, the profile and the capabilities belonged to the session's main model, so a role model (an explorer on a
// small local server, a compactor on Claude) was called with the main model's settings. Now each model carries its own card;
// wrappers (fallback, router, rate limiter, cache) pass on the card of the model that answers.
import type { Guard, Model, ModelOpts } from "./harness.ts";

/** Where a model sits: a local server, a mid-priced hosted model, or a frontier model. */
export type ModelTier = "local" | "mid" | "frontier";

/** The settings of a model's profile that travel with the model. Per-call ones are applied by `withCard`; loop ones are read by `createHarness` when its options do not set them. */
export type CardProfile = {
  toolChoice?: "auto" | "required"; thinkingBudget?: number; keepThinking?: boolean; request?: Record<string, unknown>;
  off?: Guard[]; stagnationTurns?: number; maxSteps?: number; contextBudget?: number;
  /** the only tools this model is offered (finish is always kept) */ tools?: string[];
};

export type ModelCard = {
  /** The model id as the provider knows it. */
  id?: string;
  provider?: string;
  /** Its context window in tokens, read lazily (it can be learned during the session). */
  window?: () => number | undefined;
  profile?: CardProfile;
  tier?: ModelTier;
  /** "profile" when the tier was set in the model's profile, "guess" when it was guessed from the provider and name. Only a set tier changes the prompt and tools. */
  tierFrom?: "profile" | "guess";
  caps?: { nativeTools?: boolean; parallelTools?: boolean; textToolCalls?: boolean; toolChoiceRequired?: boolean; vision?: boolean; pricedCache?: boolean };
};

/** The card of a model, or of the model a wrapper sends to right now. */
export const cardOf = (m: Model | undefined): ModelCard | undefined => m?.card;
/** The window a model says it has, if any. */
export const windowOf = (m: Model | undefined): number | undefined => { try { return m?.card?.window?.(); } catch { return undefined; } };

/**
 * Attach a card to a model. Per-call settings from the card's profile fill in what the caller did not set:
 * `toolChoice` (only when tools are offered), `thinkingBudget`, `keepThinking`, and `request` (the caller's fields win over the profile's).
 */
export function withCard(model: Model, card: ModelCard): Model {
  const p = card.profile ?? {};
  const m = (async (messages, tools, opts?: ModelOpts) => {
    const o: ModelOpts = { ...opts };
    if (o.toolChoice === undefined && p.toolChoice && tools.length) o.toolChoice = p.toolChoice;
    if (o.thinkingBudget === undefined && p.thinkingBudget !== undefined) o.thinkingBudget = p.thinkingBudget;
    if (o.keepThinking === undefined && p.keepThinking) o.keepThinking = true;
    if (p.request) o.request = { ...p.request, ...o.request };
    return model(messages, tools, o);
  }) as Model;
  Object.defineProperty(m, "appendOnly", { get: () => model.appendOnly, set: (v) => { model.appendOnly = v; }, enumerable: true });
  if (model.api) m.api = model.api;
  m.card = { ...model.card, ...card };
  return m;
}

/** Copy what a plain wrapper must keep visible from the model it wraps: appendOnly, the wire API, the card (all live, through getters). */
export function keepIdentity<T extends Model>(wrapper: T, inner: Model): T {
  Object.defineProperty(wrapper, "appendOnly", { get: () => inner.appendOnly, set: (v) => { inner.appendOnly = v; }, enumerable: true, configurable: true });
  Object.defineProperty(wrapper, "card", { get: () => inner.card, set: (v) => { inner.card = v; }, enumerable: true, configurable: true });
  if (inner.api) wrapper.api = inner.api;
  return wrapper;
}

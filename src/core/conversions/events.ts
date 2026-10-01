/**
 * Conversion event vocabulary.
 *
 * Phase 2 canonical names are stored for every new event. The original
 * names (SIGNUP, ACTIVATED, SUBSCRIBED, UPGRADED, CANCELLED) are still
 * accepted by the API as aliases and mapped to their canonical value before
 * storage; rows recorded before the rename keep their legacy value, so every
 * query counts a step through `eventTypesFor(step)` (canonical + legacy).
 */
export const CANONICAL_EVENTS = [
  "PAGE_VIEW",
  "CTA_CLICK",
  "PRODUCT_VIEWED",
  "SIGNUP_STARTED",
  "SIGNUP_COMPLETED",
  "TRIAL_STARTED",
  "ACTIVATION_COMPLETED",
  "CHECKOUT_STARTED",
  "SUBSCRIPTION_STARTED",
  "SUBSCRIPTION_UPGRADED",
  "SUBSCRIPTION_CANCELLED",
] as const;
export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

export const LEGACY_ALIASES = {
  SIGNUP: "SIGNUP_COMPLETED",
  ACTIVATED: "ACTIVATION_COMPLETED",
  SUBSCRIBED: "SUBSCRIPTION_STARTED",
  UPGRADED: "SUBSCRIPTION_UPGRADED",
  CANCELLED: "SUBSCRIPTION_CANCELLED",
} as const satisfies Record<string, CanonicalEvent>;
export type LegacyEvent = keyof typeof LEGACY_ALIASES;

/** Every name the API accepts (canonical first). */
export const ACCEPTED_EVENT_NAMES = [...CANONICAL_EVENTS, ...(Object.keys(LEGACY_ALIASES) as LegacyEvent[])] as const;
export type AcceptedEvent = CanonicalEvent | LegacyEvent;

export function canonicalEvent(type: AcceptedEvent): CanonicalEvent {
  return (LEGACY_ALIASES as Record<string, CanonicalEvent>)[type] ?? (type as CanonicalEvent);
}

/** Stored values that count as `step` (the canonical value plus its legacy alias, if any). */
export function eventTypesFor(step: CanonicalEvent): string[] {
  const legacy = Object.entries(LEGACY_ALIASES).filter(([, c]) => c === step).map(([l]) => l);
  return [step, ...legacy];
}

/** Events a browser (publishable key) may send. Everything else is a lifecycle event that needs a secret server key. */
export const PUBLISHABLE_EVENTS: ReadonlySet<CanonicalEvent> = new Set(["PAGE_VIEW", "CTA_CLICK", "PRODUCT_VIEWED", "SIGNUP_STARTED"]);

/** Fields a publishable key may never send: identity linking, consent and traits are server-side only. */
export const SECRET_ONLY_FIELDS = ["identityRef", "emailHashInput", "consent", "traits"] as const;

export function forbiddenPublishableFields(ev: Record<string, unknown>): string[] {
  return SECRET_ONLY_FIELDS.filter((f) => ev[f] !== undefined && ev[f] !== null);
}

export type Consent = { analytics: boolean; marketing: boolean; crossProduct: boolean; updatedAt?: string };

/**
 * Analytics consent rule. Consent counts only once it has been explicitly
 * recorded (a non-epoch `updatedAt`, or the consent sent with this very
 * event). An explicit `analytics: false` means the event is stored without
 * any visitor linkage: no visitor id, no identity, no session, no touch, no
 * IP hash. Unknown consent (never recorded) does not block measurement; the
 * product decides whether to send events before asking.
 */
export function analyticsAllowed(stored: Consent | null | undefined, sent?: Omit<Consent, "updatedAt"> | null): boolean {
  if (sent) return sent.analytics;
  if (!stored) return true;
  const explicit = Boolean(stored.updatedAt) && new Date(stored.updatedAt!).getTime() > 0;
  return explicit ? stored.analytics : true;
}

/** Identity product status implied by a lifecycle event (null: no status change). */
export function lifecycleStatus(type: CanonicalEvent): "TRIALING" | "ACTIVE" | "CANCELLED" | null {
  if (type === "SUBSCRIPTION_CANCELLED") return "CANCELLED";
  if (type === "SUBSCRIPTION_STARTED" || type === "SUBSCRIPTION_UPGRADED") return "ACTIVE";
  if (type === "TRIAL_STARTED") return "TRIALING";
  return null;
}

export const LIFECYCLE_EVENTS: ReadonlySet<CanonicalEvent> = new Set(["SIGNUP_COMPLETED", "TRIAL_STARTED", "ACTIVATION_COMPLETED", "SUBSCRIPTION_STARTED", "SUBSCRIPTION_UPGRADED", "SUBSCRIPTION_CANCELLED"]);

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

/** UTM parameters from a URL (values trimmed to 200 chars). */
export function utmFromUrl(url: URL | null): Utm {
  const out: Utm = {};
  if (!url) return out;
  for (const k of UTM_KEYS) {
    const v = url.searchParams.get(`utm_${k}`);
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}

/** `{source: "x"}` → `{utm_source: "x"}` (the shape the channel classifier and touches use). */
export function utmParams(u: Utm): Record<string, string> {
  return Object.fromEntries(Object.entries(u).filter(([, v]) => v).map(([k, v]) => [`utm_${k}`, v as string]));
}

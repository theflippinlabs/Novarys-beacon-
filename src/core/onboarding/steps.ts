/**
 * Onboarding v2 flow and per-step status model (pure, unit tested).
 *
 * ADD PRODUCT → WEBSITE → PRODUCT INFORMATION (sub-steps) → VERIFY KNOWLEDGE →
 * CONNECT SEARCH DATA → CONNECT ANALYTICS → INITIAL CRAWL → QUERY UNIVERSE →
 * CONTENT GAPS → OPPORTUNITIES → BEACON SCORE.
 *
 * Each step (and each PRODUCT INFORMATION sub-step) is stored in
 * `products.onboarding_steps` as `{ status, at }`: done, skipped or pending.
 * A skipped step is never shown as done.
 */
export const ONBOARDING_FLOW = [
  { key: "product", label: "Add product" },
  { key: "website", label: "Website" },
  { key: "info", label: "Product information" },
  { key: "verify", label: "Verify knowledge" },
  { key: "search", label: "Connect search data" },
  { key: "analytics", label: "Connect analytics" },
  { key: "crawl", label: "Initial crawl" },
  { key: "queries", label: "Query universe" },
  { key: "gaps", label: "Content gaps" },
  { key: "opportunities", label: "Opportunities" },
  { key: "score", label: "Beacon Score" },
] as const;
export type FlowStepKey = (typeof ONBOARDING_FLOW)[number]["key"];

/**
 * PRODUCT INFORMATION sub-steps. `section` is the knowledge form section the
 * wizard action saves (the detailed forms are unchanged: no field is lost).
 */
export const INFO_PARTS = [
  { key: "category", label: "Category", section: 3 },
  { key: "description", label: "Description", section: 4 },
  { key: "audience", label: "Audience", section: 5 },
  { key: "problems", label: "Problems solved", section: 6 },
  { key: "features", label: "Features", section: 7 },
  { key: "pricing", label: "Pricing", section: 8 },
  { key: "competitors", label: "Competitors", section: 9 },
  { key: "integrations", label: "Integrations", section: 10 },
  { key: "sources", label: "Proof / sources", section: 11 },
  { key: "conversions", label: "Conversion URLs", section: 14 },
] as const;
export type InfoPartKey = (typeof INFO_PARTS)[number]["key"];

/** Form sections of the steps that are themselves a knowledge form. */
export const STEP_SECTION: Partial<Record<FlowStepKey, number>> = { product: 1, website: 2, search: 13, analytics: 12 };

export type StepStatus = "done" | "skipped" | "pending";
export type StepState = { status: StepStatus; at: string | null };
/** Stored shape: flow step keys and `info:<part>` keys. */
export type StoredOnboardingSteps = Record<string, { status: StepStatus; at: string | null }>;

export const partKey = (part: InfoPartKey): `info:${InfoPartKey}` => `info:${part}`;
export const isFlowStep = (v: unknown): v is FlowStepKey => typeof v === "string" && ONBOARDING_FLOW.some((s) => s.key === v);
export const isInfoPart = (v: unknown): v is InfoPartKey => typeof v === "string" && INFO_PARTS.some((s) => s.key === v);
export const stepIndex = (key: FlowStepKey) => ONBOARDING_FLOW.findIndex((s) => s.key === key);

const PENDING: StepState = { status: "pending", at: null };

/**
 * Normalise the stored value. Products onboarded before v2 have no per-step
 * record: a completed onboarding counts every step as done (at the completion
 * date); an onboarding in progress counts the legacy steps it went past
 * (identity, website, product information) as done. Nothing else is assumed.
 */
export function normalizeSteps(raw: unknown, legacy: { onboardingStep: number; completedAt: Date | string | null } = { onboardingStep: 0, completedAt: null }): StoredOnboardingSteps {
  const out: StoredOnboardingSteps = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(src)) {
    if (!isFlowStep(k) && !(k.startsWith("info:") && isInfoPart(k.slice(5)))) continue;
    const s = v as { status?: unknown; at?: unknown } | null;
    if (!s || (s.status !== "done" && s.status !== "skipped" && s.status !== "pending")) continue;
    out[k] = { status: s.status, at: typeof s.at === "string" ? s.at : null };
  }
  if (Object.keys(out).length) return out;
  const completed = legacy.completedAt ? new Date(legacy.completedAt).toISOString() : null;
  if (completed) {
    for (const s of ONBOARDING_FLOW) out[s.key] = { status: "done", at: completed };
    for (const p of INFO_PARTS) out[partKey(p.key)] = { status: "done", at: completed };
    return out;
  }
  // Legacy integer steps: 1 identity, 2 website, 3..11 and 14 knowledge, 12 analytics, 13 search console.
  const reached = legacy.onboardingStep;
  if (reached > 1) out.product = { status: "done", at: null };
  if (reached > 2) out.website = { status: "done", at: null };
  for (const p of INFO_PARTS) if (reached > p.section) out[partKey(p.key)] = { status: "done", at: null };
  if (reached > 12) out.analytics = { status: "done", at: null };
  if (reached > 13) out.search = { status: "done", at: null };
  return out;
}

/** Status of one sub-step of PRODUCT INFORMATION. */
export function partState(steps: StoredOnboardingSteps, part: InfoPartKey): StepState {
  return steps[partKey(part)] ?? PENDING;
}

/**
 * Status of a flow step. PRODUCT INFORMATION is derived from its sub-steps:
 * done when every part is settled and at least one was filled in, skipped
 * when every part was skipped, pending otherwise.
 */
export function stepState(steps: StoredOnboardingSteps, key: FlowStepKey): StepState {
  if (key !== "info") return steps[key] ?? PENDING;
  const parts = INFO_PARTS.map((p) => partState(steps, p.key));
  if (parts.some((p) => p.status === "pending")) return PENDING;
  const at = parts.map((p) => p.at).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  return { status: parts.some((p) => p.status === "done") ? "done" : "skipped", at };
}

/** Record a decision on a step or sub-step (immutable). `now` is injected for tests. */
export function markStep(steps: StoredOnboardingSteps, key: FlowStepKey | `info:${InfoPartKey}`, status: StepStatus, now: Date = new Date()): StoredOnboardingSteps {
  if (key === "info") throw new Error("PRODUCT INFORMATION is settled through its sub-steps");
  // A step already done stays done when it is skipped later (skipping never erases work).
  const prev = steps[key];
  if (status === "skipped" && prev?.status === "done") return steps;
  return { ...steps, [key]: { status, at: status === "pending" ? null : now.toISOString() } };
}

export type OnboardingProgress = { done: number; skipped: number; pending: number; total: number; settledRatio: number; doneRatio: number; complete: boolean };

/** Progress over the 11 flow steps. `complete` means every step is settled (done or skipped). */
export function progress(steps: StoredOnboardingSteps): OnboardingProgress {
  let done = 0;
  let skipped = 0;
  for (const s of ONBOARDING_FLOW) {
    const st = stepState(steps, s.key).status;
    if (st === "done") done++;
    else if (st === "skipped") skipped++;
  }
  const total = ONBOARDING_FLOW.length;
  const pending = total - done - skipped;
  return { done, skipped, pending, total, settledRatio: (done + skipped) / total, doneRatio: done / total, complete: pending === 0 };
}

/** Where to resume: the first pending step (and part), or the final step when everything is settled. */
export function resumeAt(steps: StoredOnboardingSteps): { step: FlowStepKey; part: InfoPartKey | null } {
  for (const s of ONBOARDING_FLOW) {
    if (stepState(steps, s.key).status !== "pending") continue;
    if (s.key === "info") return { step: "info", part: INFO_PARTS.find((p) => partState(steps, p.key).status === "pending")?.key ?? INFO_PARTS[0].key };
    return { step: s.key, part: null };
  }
  return { step: "score", part: null };
}

/** The position after the given one (next part of PRODUCT INFORMATION, then the next flow step); null after the last step. */
export function nextPosition(step: FlowStepKey, part: InfoPartKey | null): { step: FlowStepKey; part: InfoPartKey | null } | null {
  if (step === "info") {
    const i = part ? INFO_PARTS.findIndex((p) => p.key === part) : -1;
    if (i >= 0 && i < INFO_PARTS.length - 1) return { step: "info", part: INFO_PARTS[i + 1].key };
  }
  const idx = stepIndex(step);
  if (idx < 0 || idx >= ONBOARDING_FLOW.length - 1) return null;
  const next = ONBOARDING_FLOW[idx + 1].key;
  return { step: next, part: next === "info" ? INFO_PARTS[0].key : null };
}

/** The position before the given one (for the Back link); null on the first step. */
export function previousPosition(step: FlowStepKey, part: InfoPartKey | null): { step: FlowStepKey; part: InfoPartKey | null } | null {
  if (step === "info" && part) {
    const i = INFO_PARTS.findIndex((p) => p.key === part);
    if (i > 0) return { step: "info", part: INFO_PARTS[i - 1].key };
  }
  const idx = stepIndex(step);
  if (idx <= 0) return null;
  const prev = ONBOARDING_FLOW[idx - 1].key;
  return { step: prev, part: prev === "info" ? INFO_PARTS[INFO_PARTS.length - 1].key : null };
}

/** URL of a position in the wizard. */
export function onboardingHref(slug: string, pos: { step: FlowStepKey; part?: InfoPartKey | null }): string {
  return `/products/${slug}/onboarding?step=${pos.step}${pos.step === "info" && pos.part ? `&part=${pos.part}` : ""}`;
}

/**
 * Parse the `step` / `part` URL parameters. Legacy numeric steps (1 to 14,
 * the pre-v2 wizard) map to the step that now holds that form.
 */
export function parsePosition(stepParam: string | undefined, partParam: string | undefined): { step: FlowStepKey; part: InfoPartKey | null } | null {
  if (isFlowStep(stepParam)) return { step: stepParam, part: stepParam === "info" ? (isInfoPart(partParam) ? partParam : INFO_PARTS[0].key) : null };
  const n = Number(stepParam);
  if (!Number.isInteger(n) || n < 1) return null;
  if (n === 1) return { step: "product", part: null };
  if (n === 2) return { step: "website", part: null };
  if (n === 12) return { step: "analytics", part: null };
  if (n === 13) return { step: "search", part: null };
  const part = INFO_PARTS.find((p) => p.section === n);
  return part ? { step: "info", part: part.key } : null;
}

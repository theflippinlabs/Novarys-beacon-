/**
 * Per-organisation monthly budget for the Beacon agent (pure). Usage is
 * counted in billing-weighted tokens: input (including prompt-cache writes)
 * plus output, with prompt-cache reads weighted at one tenth, as they are
 * billed. A cap of 0 or null means no cap.
 */
export type ModelUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
export type UsageRow = { inputTokens: number; outputTokens: number; requests: number };
export type BudgetStatus = { month: string; used: number; cap: number | null; remaining: number | null; pct: number | null; exceeded: boolean; requests: number };

/** UTC month key, "YYYY-MM". */
export const usageMonth = (d: Date = new Date()) => d.toISOString().slice(0, 7);

/** Billing-weighted token counts of one model response. */
export function weightedTokens(u: ModelUsage | null | undefined): { input: number; output: number } {
  if (!u) return { input: 0, output: 0 };
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + Math.ceil(n(u.cache_read_input_tokens) / 10), output: n(u.output_tokens) };
}

/** The organisation's cap when set (0 = explicitly no cap), else the deployment default (0 = no cap). */
export function resolveCap(orgCap: number | null | undefined, defaultCap: number): number | null {
  const c = orgCap === null || orgCap === undefined ? defaultCap : orgCap;
  return Number.isFinite(c) && c > 0 ? Math.floor(c) : null;
}

export function budgetStatus(usage: UsageRow | null | undefined, cap: number | null, month: string): BudgetStatus {
  const used = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const requests = usage?.requests ?? 0;
  if (cap === null) return { month, used, cap: null, remaining: null, pct: null, exceeded: false, requests };
  return { month, used, cap, remaining: Math.max(0, cap - used), pct: Math.min(100, Math.round((used / cap) * 100)), exceeded: used >= cap, requests };
}

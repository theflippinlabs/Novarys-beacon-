import type { Estimate, ImpactEstimate } from "@/core/estimate/types";
import { SPECIALISTS, severityRank, type CoverageMap, type Evidence, type Finding, type FindingSeverity, type SpecialistReport } from "./types";

/**
 * Merging and ranking (pure, docs/BEACON_BRAIN.md §5). Findings of every
 * specialist are deduplicated (same opportunity, same key, or same search
 * target), then split: estimable findings are ranked by expected extra
 * signups (p50), then revenue, then severity, then effort; findings whose
 * signups cannot be estimated are kept in a separate list ordered by
 * severity, so an unknown is never ranked as a zero.
 */

export const MAX_EVIDENCE = 12;

const maxSeverity = (a: FindingSeverity, b: FindingSeverity): FindingSeverity => (severityRank(a) <= severityRank(b) ? a : b);

export function unionEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set(a.map((e) => `${e.label}\u0000${e.value}`));
  const out = [...a];
  for (const e of b) {
    const k = `${e.label}\u0000${e.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.slice(0, MAX_EVIDENCE);
}

/** Fold `other` into `into` (same underlying problem): highest severity, evidence union, first non-empty links. */
export function foldFinding(into: Finding, other: Finding): Finding {
  const alsoFrom = new Set(into.alsoFrom ?? []);
  if (other.specialist !== into.specialist) alsoFrom.add(other.specialist);
  for (const s of other.alsoFrom ?? []) if (s !== into.specialist) alsoFrom.add(s);
  return {
    ...into,
    severity: maxSeverity(into.severity, other.severity),
    effort: Math.min(into.effort, other.effort),
    evidence: unionEvidence(into.evidence, other.evidence),
    opportunityId: into.opportunityId ?? other.opportunityId,
    productId: into.productId ?? other.productId,
    target: into.target ?? other.target,
    estimate: into.estimate ?? other.estimate,
    ...(alsoFrom.size ? { alsoFrom: [...alsoFrom] } : {}),
  };
}

/** Same search target: same product, action type and set of queries (only when queries are known). */
export function targetSignature(f: Finding): string | null {
  const t = f.target;
  if (!t?.queryIds?.length) return null;
  return `${t.productId ?? "org"}|${t.opportunityType ?? ""}|${[...t.queryIds].sort().join(",")}`;
}

export const dedupeKey = (f: Finding) => (f.opportunityId ? `opp:${f.opportunityId}` : f.key);

/** Deduplicate across specialists (reports in specialist order, findings in report order). */
export function mergeFindings(reports: SpecialistReport[]): Finding[] {
  const ordered = [...reports].sort((a, b) => SPECIALISTS.indexOf(a.specialist) - SPECIALISTS.indexOf(b.specialist));
  const out: Finding[] = [];
  const byKey = new Map<string, number>();
  const bySig = new Map<string, number>();
  for (const r of ordered)
    for (const f of r.findings) {
      const k = dedupeKey(f);
      const sig = targetSignature(f);
      const at = byKey.get(k) ?? (sig ? bySig.get(sig) : undefined);
      if (at !== undefined) {
        out[at] = foldFinding(out[at], f);
        byKey.set(k, at);
        continue;
      }
      out.push(f);
      byKey.set(k, out.length - 1);
      if (sig) bySig.set(sig, out.length - 1);
    }
  return out;
}

const estimated = (e: Estimate | undefined): e is Extract<Estimate, { state: "ESTIMATED" }> => e?.state === "ESTIMATED";

export const isEstimable = (f: Finding) => estimated(f.estimate?.signups);

function revenueOf(e: ImpactEstimate | undefined) {
  const r = e?.revenue.find((x) => estimated(x));
  return r && estimated(r) ? { currency: r.currency ?? "", p50: r.p50 } : null;
}

export function compareEstimable(a: Finding, b: Finding): number {
  const sa = a.estimate!.signups;
  const sb = b.estimate!.signups;
  const pa = estimated(sa) ? sa.p50 : 0;
  const pb = estimated(sb) ? sb.p50 : 0;
  if (pb !== pa) return pb - pa;
  const ra = revenueOf(a.estimate);
  const rb = revenueOf(b.estimate);
  // Revenue is compared only in the same currency (currencies are never mixed); a measured revenue estimate ranks first.
  if (ra && rb && ra.currency === rb.currency && ra.p50 !== rb.p50) return rb.p50 - ra.p50;
  if (ra && !rb) return -1;
  if (rb && !ra) return 1;
  return severityRank(a.severity) - severityRank(b.severity) || a.effort - b.effort || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/** Non-estimable findings: severity, then the specialist's own order (possibly set by its LLM pass), then effort. */
export function compareUnestimated(order: Map<string, number>) {
  return (a: Finding, b: Finding) =>
    severityRank(a.severity) - severityRank(b.severity) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.effort - b.effort || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function rankFindings(reports: SpecialistReport[]): { ranked: Finding[]; unestimated: Finding[] } {
  const order = new Map<string, number>();
  for (const r of reports) r.findings.forEach((f, i) => order.set(f.id, i));
  const merged = mergeFindings(reports);
  return { ranked: merged.filter(isEstimable).sort(compareEstimable), unestimated: merged.filter((f) => !isEstimable(f)).sort(compareUnestimated(order)) };
}

export function coverageMap(reports: SpecialistReport[]): CoverageMap {
  const out = {} as CoverageMap;
  for (const k of SPECIALISTS) {
    const r = reports.find((x) => x.specialist === k);
    out[k] = r ? { coverage: r.coverage, missing: r.missing, findings: r.findings.length } : { coverage: "NOT_CONNECTED", missing: [], findings: 0 };
  }
  return out;
}

/** Critical findings of this run that were not critical in the previous one (by dedupe key). */
export function newCriticalFindings(current: Finding[], previousCriticalKeys: ReadonlySet<string>): Finding[] {
  return current.filter((f) => f.severity === "CRITICAL" && !previousCriticalKeys.has(dedupeKey(f)));
}

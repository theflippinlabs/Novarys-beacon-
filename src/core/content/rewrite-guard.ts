import type { ClaimCheck, FactCheckResult } from "@/db/schema";
import { claimSeverity } from "./fact-check";
import { EDITOR_TODO } from "./markers";

/** Lines a rewrite must keep verbatim: editor TODOs block approval until a human resolves them. */
export function todoLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(EDITOR_TODO));
}

/** URLs listed under "## Sources" (and any autolinked URL), normalised without trailing slashes. */
export function sourceUrls(body: string): string[] {
  const out = new Set<string>();
  const sources = body.split(/^## Sources\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  for (const m of sources.matchAll(/https?:\/\/[^\s<>)]+/g)) out.add(m[0].replace(/\/+$/, ""));
  return [...out];
}

/** `{cta:KIND}` markers with their multiplicity. */
export function ctaMarkers(body: string): string[] {
  return [...body.matchAll(/\{cta:[^}]*\}/g)].map((m) => m[0]).sort();
}

const notSupported = (c: ClaimCheck) => c.status !== "SUPPORTED";
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type GuardResult = { ok: boolean; reasons: string[] };

/**
 * Decides whether an LLM rewrite may replace the deterministic template.
 * Rejected when it removes an editor TODO line, a Sources URL or a CTA
 * marker present in the template, adds a claim the facts do not support,
 * or raises the NEEDS_REVIEW, UNSUPPORTED or HIGH-severity counts.
 */
export function guardRewrite(template: { body: string }, rewrite: { body: string }, before: FactCheckResult, after: FactCheckResult): GuardResult {
  const reasons: string[] = [];
  const kept = new Set(todoLines(rewrite.body));
  const lostTodos = todoLines(template.body).filter((l) => !kept.has(l));
  if (lostTodos.length) reasons.push(`Removed ${lostTodos.length} editor TODO line(s)`);

  const rewriteText = rewrite.body.replace(/\/+(?=[\s>)]|$)/gm, "");
  const lostSources = sourceUrls(template.body).filter((u) => !rewriteText.includes(u));
  if (lostSources.length) reasons.push(`Removed ${lostSources.length} source URL(s)`);

  const ctas = ctaMarkers(rewrite.body);
  const lostCtas = ctaMarkers(template.body).filter((m) => {
    const i = ctas.indexOf(m);
    if (i === -1) return true;
    ctas.splice(i, 1);
    return false;
  });
  if (lostCtas.length) reasons.push(`Removed ${lostCtas.length} CTA marker(s)`);

  const count = (r: FactCheckResult, f: (c: ClaimCheck) => boolean) => r.claims.filter(f).length;
  if (count(after, (c) => c.status === "NEEDS_REVIEW") > count(before, (c) => c.status === "NEEDS_REVIEW")) reasons.push("More claims need review");
  if (count(after, (c) => c.status === "UNSUPPORTED") > count(before, (c) => c.status === "UNSUPPORTED")) reasons.push("More unsupported claims");
  if (count(after, (c) => claimSeverity(c) === "HIGH") > count(before, (c) => claimSeverity(c) === "HIGH")) reasons.push("More high-severity claims");
  const known = new Set(before.claims.filter(notSupported).map((c) => norm(c.claim)));
  const added = after.claims.filter((c) => notSupported(c) && claimSeverity(c) !== "LOW" && !known.has(norm(c.claim)));
  if (added.length) reasons.push(`Adds ${added.length} claim(s) the verified facts do not support`);

  return { ok: reasons.length === 0, reasons };
}

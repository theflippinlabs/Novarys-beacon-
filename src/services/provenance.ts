import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { memberships, organizations, productChangelog, productClaims, productFacets, productFaqs, productPricing, productProofs, products, productSources } from "@/db/schema";
import { computeConfidence, DEFAULT_STALE_AFTER_DAYS, isFailingSource, type SourceKind, type Verification } from "@/core/knowledge/confidence";
import { CLAIM_FIELDS, claimValue, detectConflicts, outdatedStatus, pricingConflictCandidate, verificationAfterEdit, verificationError, type ClaimField } from "@/core/knowledge/provenance";
import type { Product } from "@/core/knowledge/types";
import { can, ForbiddenError, type Role } from "@/lib/auth/rbac";
import { audit, type Actor } from "@/lib/audit";

/**
 * Knowledge provenance: per-claim verification, verifier, date, confidence,
 * OUTDATED / CONFLICTING detection. Every write path that changes a fact goes
 * through these helpers so a verified value can never change silently.
 */
export const FACT_KINDS = ["facet", "pricing", "faq", "proof", "changelog", "claim"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_TABLES = { facet: productFacets, pricing: productPricing, faq: productFaqs, proof: productProofs, changelog: productChangelog, claim: productClaims } as const;

type ProvenanceRow = { id: string; productId: string; organizationId: string; sourceId: string | null; verification: Verification; verifiedAt: Date | null; confidence: number | null };
type ProvenancePatch = { verification?: Verification; verifiedAt?: Date | null; verifiedBy?: string | null; confidence?: number | null; sourceId?: string | null };

/** Typed per-table access (Drizzle cannot update a union of tables generically). */
async function getRow(tx: Tx, kind: FactKind, organizationId: string, id: string): Promise<(ProvenanceRow & Record<string, unknown>) | undefined> {
  const t = FACT_TABLES[kind] as typeof productFacets;
  const [row] = await tx.select().from(t).where(and(eq(t.id, id), eq(t.organizationId, organizationId))).limit(1);
  return row as (ProvenanceRow & Record<string, unknown>) | undefined;
}

async function patchRow(tx: Tx, kind: FactKind, id: string, set: ProvenancePatch & Record<string, unknown>) {
  const t = FACT_TABLES[kind] as typeof productFacets;
  await tx.update(t).set(set as Partial<typeof productFacets.$inferInsert>).where(eq(t.id, id));
}

/** Organisation setting: verified claims older than this many days become OUTDATED. */
export async function staleAfterDays(tx: Tx, organizationId: string): Promise<number> {
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId), columns: { settings: true } });
  const v = org?.settings.knowledge?.staleAfterDays;
  return typeof v === "number" && v >= 7 && v <= 3650 ? Math.round(v) : DEFAULT_STALE_AFTER_DAYS;
}

type SourceInfo = { kind: SourceKind; failing: boolean; url: string };

async function sourceMap(tx: Tx, productId: string): Promise<Map<string, SourceInfo>> {
  const rows = await tx.select().from(productSources).where(eq(productSources.productId, productId));
  return new Map(rows.map((s) => [s.id, { kind: s.kind, failing: isFailingSource(s), url: s.url }]));
}

function confidenceFor(row: { verification: Verification; verifiedAt: Date | null; sourceId: string | null }, sources: Map<string, SourceInfo>, staleDays: number, now = new Date()) {
  const s = row.sourceId ? sources.get(row.sourceId) : undefined;
  return computeConfidence({ verification: row.verification, source: s ? { kind: s.kind, failing: s.failing } : null, verifiedAt: row.verifiedAt, now, staleAfterDays: staleDays });
}

/** Only human members with `fact:verify` (owners and admins) may change verification. The agent never can. */
export async function assertCanVerify(tx: Tx, actor: Actor) {
  if (actor.via === "agent" || !actor.userId || (actor.actorType && actor.actorType !== "USER")) throw new ForbiddenError("fact:verify");
  const m = await tx.query.memberships.findFirst({ where: and(eq(memberships.organizationId, actor.organizationId), eq(memberships.userId, actor.userId)) });
  if (!m || !can(m.role as Role, "fact:verify")) throw new ForbiddenError("fact:verify");
}

/**
 * Set the verification of one fact (facet, pricing plan, FAQ, proof,
 * changelog entry or scalar claim). VERIFIED requires a source (an existing
 * link or `sourceId` given here) and stamps verified_at / verified_by; any
 * other status clears the stamp. Confidence is recomputed.
 */
export async function setFactVerification(tx: Tx, actor: Actor, input: { kind: FactKind; id: string; verification: Verification; sourceId?: string | null }) {
  await assertCanVerify(tx, actor);
  const row = await getRow(tx, input.kind, actor.organizationId, input.id);
  if (!row) throw new Error("Fact not found");
  let sourceId = row.sourceId;
  if (input.sourceId) {
    const src = await tx.query.productSources.findFirst({ where: and(eq(productSources.id, input.sourceId), eq(productSources.organizationId, actor.organizationId), eq(productSources.productId, row.productId)) });
    if (!src) throw new Error("Source not found for this product");
    sourceId = src.id;
  }
  const err = verificationError(input.verification, { sourceId });
  if (err) throw new Error(err);
  if (input.verification === "VERIFIED" && input.kind === "faq" && !String(row.answer ?? "").trim()) throw new Error("Write the answer before verifying this FAQ.");
  const verified = input.verification === "VERIFIED";
  const now = new Date();
  const next = { verification: input.verification, verifiedAt: verified ? now : null, sourceId };
  const sources = await sourceMap(tx, row.productId);
  await patchRow(tx, input.kind, row.id, { ...next, verifiedBy: verified ? actor.userId! : null, confidence: confidenceFor(next, sources, await staleAfterDays(tx, actor.organizationId), now) });
  await audit(tx, actor, "knowledge.verify", input.kind, row.id, { verification: input.verification, sourceId });
  return { productId: row.productId, verification: input.verification };
}

/**
 * Link (or unlink) a fact's source. A VERIFIED fact whose source changes was
 * verified against something else, so it goes back to NEEDS_REVIEW.
 */
export async function setFactSource(tx: Tx, actor: Actor, input: { kind: FactKind; id: string; sourceId: string | null }) {
  const row = await getRow(tx, input.kind, actor.organizationId, input.id);
  if (!row) throw new Error("Fact not found");
  if (input.sourceId) {
    const src = await tx.query.productSources.findFirst({ where: and(eq(productSources.id, input.sourceId), eq(productSources.organizationId, actor.organizationId), eq(productSources.productId, row.productId)) });
    if (!src) throw new Error("Source not found");
  }
  const changed = (row.sourceId ?? null) !== (input.sourceId ?? null);
  const verification = verificationAfterEdit(row.verification, changed);
  const keepStamp = verification === row.verification;
  const next = { verification, verifiedAt: keepStamp ? row.verifiedAt : null, sourceId: input.sourceId };
  const sources = await sourceMap(tx, row.productId);
  await patchRow(tx, input.kind, row.id, { ...next, ...(keepStamp ? {} : { verifiedBy: null }), confidence: confidenceFor(next, sources, await staleAfterDays(tx, actor.organizationId)) });
  if (changed) await audit(tx, actor, "knowledge.source", input.kind, row.id, { sourceId: input.sourceId, verification });
  return { changed, verification };
}

/**
 * Apply an edit to a list fact (facet, pricing plan, FAQ, proof, changelog).
 * When any value field actually changes, a VERIFIED (or OUTDATED /
 * CONFLICTING) fact returns to NEEDS_REVIEW and loses its verified stamp.
 */
export async function editFact(tx: Tx, actor: Actor, kind: Exclude<FactKind, "claim">, id: string, patch: Record<string, unknown>) {
  const row = await getRow(tx, kind, actor.organizationId, id);
  if (!row) throw new Error("Fact not found");
  const changed = Object.entries(patch).some(([k, v]) => JSON.stringify(row[k] ?? null) !== JSON.stringify(v ?? null));
  if (!changed) return { changed: false, verification: row.verification };
  const verification = verificationAfterEdit(row.verification, true);
  const reset = verification !== row.verification;
  const next = { verification, verifiedAt: reset ? null : row.verifiedAt, sourceId: row.sourceId };
  const sources = await sourceMap(tx, row.productId);
  await patchRow(tx, kind, id, { ...patch, verification, ...(reset ? { verifiedAt: null, verifiedBy: null } : {}), confidence: confidenceFor(next, sources, await staleAfterDays(tx, actor.organizationId)) });
  await audit(tx, actor, "knowledge.edit", kind, id, { fields: Object.keys(patch), verification });
  return { changed: true, verification };
}

/** Provenance columns to merge into a sync update when a value changed (wizard re-sync). */
export function resetOnChange(prev: { verification: Verification }, changed: boolean): ProvenancePatch {
  const verification = verificationAfterEdit(prev.verification, changed);
  if (verification === prev.verification) return {};
  return { verification, verifiedAt: null, verifiedBy: null, confidence: null };
}

/**
 * Keep `product_claims` in sync with the `products` columns after an edit
 * (one helper for the wizard, updateProduct and the agent). Products that
 * never had claims get them first (VERIFIED with `lastVerifiedAt` when the
 * product was verified, as in the migration backfill). Then, per changed
 * field, the claim that held the previous value takes the new value and goes
 * back to review if it was verified; a cleared field drops its claim.
 */
export async function syncProductClaims(tx: Tx, actor: Actor, before: Product, after: Product): Promise<ClaimField[]> {
  let claims = await tx.select().from(productClaims).where(eq(productClaims.productId, before.id));
  if (!claims.length) {
    const seed = CLAIM_FIELDS.map((field) => ({ field, value: claimValue(before, field) })).filter((x): x is { field: ClaimField; value: string } => x.value !== null);
    if (seed.length)
      claims = await tx
        .insert(productClaims)
        .values(seed.map((x) => ({ organizationId: before.organizationId, productId: before.id, field: x.field, value: x.value, verification: before.lastVerifiedAt ? ("VERIFIED" as const) : ("UNVERIFIED" as const), verifiedAt: before.lastVerifiedAt })))
        .returning();
  }
  const changed: ClaimField[] = [];
  const reset: ClaimField[] = [];
  let ctx: { sources: Map<string, SourceInfo>; staleDays: number } | null = null;
  for (const field of CLAIM_FIELDS) {
    const oldV = claimValue(before, field);
    const newV = claimValue(after, field);
    if (oldV === newV) continue;
    changed.push(field);
    const list = claims.filter((c) => c.field === field);
    const primary = oldV === null ? undefined : (list.find((c) => c.value === oldV && c.verification === "VERIFIED") ?? list.find((c) => c.value === oldV));
    if (newV === null) {
      if (primary) await tx.delete(productClaims).where(eq(productClaims.id, primary.id));
      continue;
    }
    ctx ??= { sources: await sourceMap(tx, before.id), staleDays: await staleAfterDays(tx, before.organizationId) };
    if (primary) {
      const verification = verificationAfterEdit(primary.verification, true);
      if (verification !== primary.verification) reset.push(field);
      const next = { verification, verifiedAt: verification === primary.verification ? primary.verifiedAt : null, sourceId: primary.sourceId };
      await tx
        .update(productClaims)
        .set({ value: newV, ...next, ...(next.verifiedAt ? {} : { verifiedBy: null }), confidence: confidenceFor(next, ctx.sources, ctx.staleDays) })
        .where(eq(productClaims.id, primary.id));
    } else if (!list.some((c) => c.value === newV)) {
      const next = { verification: "UNVERIFIED" as const, verifiedAt: null, sourceId: null };
      await tx.insert(productClaims).values({ organizationId: before.organizationId, productId: before.id, field, value: newV, ...next, confidence: confidenceFor(next, ctx.sources, ctx.staleDays) });
    }
  }
  if (changed.length) await audit(tx, actor, "knowledge.claims.sync", "product", before.id, { fields: changed, reverify: reset });
  return reset;
}

/** Facts sourced by these sources lose their source (they are being removed): verified ones go back to review. */
export async function resetFactsForRemovedSources(tx: Tx, sourceIds: string[]) {
  if (!sourceIds.length) return;
  for (const t of Object.values(FACT_TABLES) as (typeof productFacets)[]) {
    await tx
      .update(t)
      .set({ verification: "NEEDS_REVIEW", verifiedAt: null, verifiedBy: null, confidence: null })
      .where(and(inArray(t.sourceId, sourceIds), inArray(t.verification, ["VERIFIED", "OUTDATED", "CONFLICTING"])));
  }
}

/**
 * Recompute OUTDATED / CONFLICTING statuses and stored confidence for every
 * fact of a product (run after source checks and on demand).
 * - OUTDATED: sourced by a failing source, or VERIFIED longer than the
 *   organisation's `staleAfterDays` ago.
 * - CONFLICTING: two claims for the same field (scalar claims) or the same
 *   plan (pricing price/currency/interval) disagree with different sources.
 *   A claim no longer in conflict returns to NEEDS_REVIEW.
 */
export async function refreshProvenance(tx: Tx, organizationId: string, productId: string, now = new Date()) {
  const sources = await sourceMap(tx, productId);
  const staleDays = await staleAfterDays(tx, organizationId);
  const counts = { outdated: 0, conflicting: 0, updated: 0 };
  const claims = await tx.select().from(productClaims).where(eq(productClaims.productId, productId));
  const pricing = await tx.select().from(productPricing).where(eq(productPricing.productId, productId));
  const conflicts = new Set([
    ...detectConflicts(claims.map((c) => ({ id: c.id, key: c.field, value: c.value, sourceId: c.sourceId, verification: c.verification }))),
    ...detectConflicts(pricing.map((p) => pricingConflictCandidate(p))),
  ]);
  const rowsByKind: [FactKind, ProvenanceRow[]][] = [
    ["claim", claims],
    ["pricing", pricing],
    ["facet", await tx.select().from(productFacets).where(eq(productFacets.productId, productId))],
    ["faq", await tx.select().from(productFaqs).where(eq(productFaqs.productId, productId))],
    ["proof", await tx.select().from(productProofs).where(eq(productProofs.productId, productId))],
    ["changelog", await tx.select().from(productChangelog).where(eq(productChangelog.productId, productId))],
  ];
  for (const [kind, rows] of rowsByKind)
    for (const r of rows) {
      let next: Verification = outdatedStatus({ verification: r.verification, verifiedAt: r.verifiedAt, sourceFailing: Boolean(r.sourceId && sources.get(r.sourceId)?.failing) }, now, staleDays) ?? r.verification;
      if (conflicts.has(r.id) && r.verification !== "REJECTED") next = "CONFLICTING";
      else if (r.verification === "CONFLICTING") next = "NEEDS_REVIEW";
      const confidence = confidenceFor({ verification: next, verifiedAt: r.verifiedAt, sourceId: r.sourceId }, sources, staleDays, now);
      if (next === "OUTDATED" && r.verification !== "OUTDATED") counts.outdated++;
      if (next === "CONFLICTING" && r.verification !== "CONFLICTING") counts.conflicting++;
      if (next !== r.verification || confidence !== r.confidence) {
        await patchRow(tx, kind, r.id, { verification: next, confidence });
        counts.updated++;
      }
    }
  return counts;
}

export type SourceCheckResult = { status: number | null; error: string | null };
export type SourceFetcher = (url: string, method: "HEAD" | "GET") => Promise<{ status: number }>;

/** HEAD first, GET when HEAD is refused or fails (many servers mishandle HEAD). Never throws. */
export async function checkUrl(url: string, fetcher: SourceFetcher): Promise<SourceCheckResult> {
  let status: number | null = null;
  let error: string | null = null;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      status = (await fetcher(url, method)).status;
      error = null;
      if (status > 0 && status < 400) break;
    } catch (e) {
      status = null;
      error = (e as Error).message.slice(0, 300);
    }
  }
  return { status, error: error ?? (status === null || status >= 400 ? `HTTP ${status ?? "error"}` : null) };
}

/**
 * Weekly source liveness check for one organisation (`sources.check` job).
 * Network I/O happens outside database transactions: sources are read in one
 * transaction, fetched, then results are written and provenance refreshed per
 * product in short transactions.
 */
export async function checkOrganizationSources(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, organizationId: string, fetcher: SourceFetcher, now = new Date()) {
  const list = await run((tx) => tx.select({ id: productSources.id, url: productSources.url, productId: productSources.productId, failures: productSources.consecutiveFailures }).from(productSources).where(eq(productSources.organizationId, organizationId)));
  const results: { id: string; productId: string; failures: number; res: SourceCheckResult }[] = [];
  for (const s of list) results.push({ id: s.id, productId: s.productId, failures: s.failures, res: await checkUrl(s.url, fetcher) });
  let failing = 0;
  await run(async (tx) => {
    for (const r of results) {
      const failed = r.res.status === null || r.res.status >= 400;
      if (failed) failing++;
      await tx
        .update(productSources)
        .set({ httpStatus: r.res.status, lastCheckedAt: now, consecutiveFailures: failed ? r.failures + 1 : 0, lastError: failed ? r.res.error : null })
        .where(eq(productSources.id, r.id));
    }
  });
  const productIds = await run((tx) => tx.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId)));
  const totals = { checked: results.length, failing, outdated: 0, conflicting: 0 };
  for (const p of productIds) {
    const c = await run((tx) => refreshProvenance(tx, organizationId, p.id, now));
    totals.outdated += c.outdated;
    totals.conflicting += c.conflicting;
  }
  return totals;
}

/**
 * "I verified the core descriptions": verify every current scalar claim of a
 * product that has a source (its own, or `sourceId` chosen by the reviewer).
 * Claims without any source stay as they are and are reported as skipped.
 */
export async function verifyProductClaims(tx: Tx, actor: Actor, productId: string, sourceId: string | null) {
  await assertCanVerify(tx, actor);
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) });
  if (!product) throw new Error("Product not found");
  let claims = await tx.select().from(productClaims).where(eq(productClaims.productId, productId));
  if (!claims.length) {
    await syncProductClaims(tx, actor, product, product);
    claims = await tx.select().from(productClaims).where(eq(productClaims.productId, productId));
  }
  let verified = 0;
  let skipped = 0;
  for (const field of CLAIM_FIELDS) {
    const value = claimValue(product, field);
    if (value === null) continue;
    const c = claims.find((x) => x.field === field && x.value === value);
    if (!c || c.verification === "REJECTED") continue;
    if (!c.sourceId && !sourceId) {
      skipped++;
      continue;
    }
    if (c.verification === "VERIFIED" && c.sourceId) {
      verified++;
      continue;
    }
    await setFactVerification(tx, actor, { kind: "claim", id: c.id, verification: "VERIFIED", sourceId: c.sourceId ?? sourceId });
    verified++;
  }
  if (verified && !skipped) await tx.update(products).set({ lastVerifiedAt: new Date() }).where(eq(products.id, productId));
  await audit(tx, actor, "knowledge.product_verified", "product", productId, { verified, skipped, sourceId });
  return { verified, skipped };
}

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { campaigns, contentAssets, distributionTargets, opportunities, products } from "@/db/schema";
import {
  approvalBlockers,
  approvalValid,
  assertDistributionTransition,
  buildTrackingLink,
  CATEGORY_FOR_CITATION,
  CATEGORY_FOR_KIND,
  channelFor,
  KIND_FOR_CATEGORY,
  listingTypeFor,
  REQUIRES_APPROVAL,
  resetsApproval,
  utmCampaignFor,
  utmMediumFor,
  utmSourceFor,
  type DistributionStatus,
} from "@/core/distribution/catalog";
import { rankVenues, relevanceReasonText, seedableVenues, type CitationSignal, type ProductFit } from "@/core/distribution/relevance";
import { venueByKey, VENUES, type DistributionCategory, type Venue } from "@/core/distribution/venues";
import { loadProductGraph } from "@/core/knowledge/load";
import type { ProductGraph } from "@/core/knowledge/types";
import { randomToken } from "@/lib/security/crypto";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { citationDomains } from "./ai-visibility";
import { availability } from "./metrics";
import { createAsset } from "./content";

type Target = typeof distributionTargets.$inferSelect;

/** Product fit inputs for venue relevance, from the knowledge graph. */
export function productFit(g: ProductGraph): ProductFit {
  const p = g.product;
  return {
    category: p.category ?? null,
    status: p.status,
    texts: [p.shortDescription ?? "", p.fullDescription ?? "", ...(p.keywords ?? [])],
    facets: g.facets.filter((f) => f.verification !== "REJECTED").map((f) => ({ kind: f.kind, name: f.name })),
  };
}

/** Third-party domains cited in sampled AI answers for the product (90 days). */
async function citationSignals(tx: Tx, organizationId: string, productId: string): Promise<CitationSignal[]> {
  return (await citationDomains(tx, organizationId, { productId })).filter((d) => d.kind === "THIRD_PARTY").map((d) => ({ domain: d.domain, samples: d.samplesCiting }));
}

export async function addDistributionTarget(
  tx: Tx,
  actor: Actor,
  input: { name: string; kind: Target["kind"]; url: string | null; productId: string | null; relevance?: number | null; notes?: string | null; category?: DistributionCategory | null; requirements?: string | null },
) {
  if (input.productId) {
    const p = await tx.query.products.findFirst({ where: and(eq(products.id, input.productId), eq(products.organizationId, actor.organizationId)) });
    if (!p) throw new Error("Product not found");
  }
  const [row] = await tx
    .insert(distributionTargets)
    .values({
      organizationId: actor.organizationId,
      name: input.name,
      kind: input.kind,
      category: input.category ?? CATEGORY_FOR_KIND[input.kind],
      url: input.url,
      productId: input.productId,
      relevance: input.relevance ?? null,
      relevanceReason: input.relevance != null ? "Set by a person" : null,
      requirements: input.requirements ?? null,
      notes: input.notes,
      lastAction: "Added",
      lastActionAt: new Date(),
    })
    .returning();
  await audit(tx, actor, "distribution.add", "distribution_target", row.id, { kind: row.kind, category: row.category });
  return row;
}

/**
 * Seeding (product analysis): catalogue venues that apply to the product and
 * reach the seed relevance, ranked by fit (category, facets, stage, AI
 * citation sources). Existing targets (same venue or name) are kept.
 */
export async function seedDistributionTargets(tx: Tx, organizationId: string, productId: string, graph?: ProductGraph | null) {
  const g = graph ?? (await loadProductGraph(tx, organizationId, productId));
  if (!g) throw new Error("Product not found");
  const existing = await tx.select({ name: distributionTargets.name, key: distributionTargets.catalogKey }).from(distributionTargets).where(and(eq(distributionTargets.organizationId, organizationId), eq(distributionTargets.productId, productId)));
  const ranked = seedableVenues(VENUES, productFit(g), await citationSignals(tx, organizationId, productId));
  let suggested = 0;
  for (const r of ranked) {
    if (existing.some((e) => e.key === r.venue.key || e.name === r.venue.name)) continue;
    await tx.insert(distributionTargets).values(venueRow(organizationId, productId, r.venue, r.score, relevanceReasonText(r), "DISCOVERED", "Suggested from the Beacon venue catalogue"));
    suggested++;
  }
  return suggested;
}

function venueRow(organizationId: string, productId: string | null, v: Venue, score: number, reason: string, status: "DISCOVERED" | "QUALIFIED", action: string) {
  return {
    organizationId,
    productId,
    kind: v.kind,
    category: v.category,
    catalogKey: v.key,
    name: v.name,
    url: v.url,
    status,
    relevance: score,
    relevanceReason: reason,
    requirements: v.requirements,
    lastAction: action,
    lastActionAt: new Date(),
  } satisfies typeof distributionTargets.$inferInsert;
}

/**
 * Autopilot execution for an approved DISTRIBUTION or CITATION opportunity:
 * adds QUALIFIED targets (catalogue venues of the needed category ranked by
 * fit, or the cited domain). Never submits anything.
 */
export async function prepareTargetsForOpportunity(tx: Tx, actor: Actor, o: typeof opportunities.$inferSelect) {
  if (!o.productId) throw new Error("Opportunity has no product");
  const g = await loadProductGraph(tx, actor.organizationId, o.productId);
  if (!g) throw new Error("Product not found");
  const existing = await tx.select({ name: distributionTargets.name, key: distributionTargets.catalogKey, url: distributionTargets.url }).from(distributionTargets).where(and(eq(distributionTargets.organizationId, actor.organizationId), eq(distributionTargets.productId, o.productId)));
  const citations = await citationSignals(tx, actor.organizationId, o.productId);
  const created: Target[] = [];
  const action = "Added by an approved autopilot recommendation";
  if (o.type === "CITATION") {
    const domain = /^citation:[^:]+:(.+)$/.exec(o.fingerprint)?.[1];
    if (!domain) return created;
    const venue = VENUES.find((v) => v.domains.some((d) => domain === d || domain.endsWith(`.${d}`)));
    if (venue) {
      if (existing.some((e) => e.key === venue.key || e.name === venue.name)) return created;
      const r = rankVenues([venue], productFit(g), citations)[0];
      const [row] = await tx.insert(distributionTargets).values(venueRow(actor.organizationId, o.productId, venue, r.score, relevanceReasonText(r), "QUALIFIED", action)).returning();
      created.push(row);
    } else {
      if (existing.some((e) => e.name === domain || (e.url ?? "").includes(domain))) return created;
      const cited = (await citationDomains(tx, actor.organizationId, { productId: o.productId })).find((d) => d.domain === domain);
      const category: DistributionCategory = (cited && CATEGORY_FOR_CITATION[cited.category]) || "PUBLICATION";
      const samples = cited?.samplesCiting ?? 0;
      const [row] = await tx
        .insert(distributionTargets)
        .values({
          organizationId: actor.organizationId,
          productId: o.productId,
          kind: KIND_FOR_CATEGORY[category],
          category,
          name: domain,
          url: `https://${domain}`,
          status: "QUALIFIED",
          relevance: Math.min(100, 50 + samples * 5),
          relevanceReason: `Cited as a source in ${samples} sampled AI answer(s)`,
          lastAction: action,
          lastActionAt: new Date(),
        })
        .returning();
      created.push(row);
    }
  } else {
    const kind = /^distribution:[^:]+:(.+)$/.exec(o.fingerprint)?.[1] as keyof typeof CATEGORY_FOR_KIND | undefined;
    const category = kind ? CATEGORY_FOR_KIND[kind] : undefined;
    const ranked = rankVenues(
      VENUES.filter((v) => !category || v.category === category || (category === "SOFTWARE_DIRECTORY" && v.category === "REVIEW_PLATFORM")),
      productFit(g),
      citations,
    ).filter((r) => r.applicable && r.score >= 40 && !existing.some((e) => e.key === r.venue.key || e.name === r.venue.name));
    for (const r of ranked.slice(0, 3)) {
      const [row] = await tx.insert(distributionTargets).values(venueRow(actor.organizationId, o.productId, r.venue, r.score, relevanceReasonText(r), "QUALIFIED", action)).returning();
      created.push(row);
    }
  }
  for (const t of created) await audit(tx, actor, "distribution.add", "distribution_target", t.id, { kind: t.kind, category: t.category, via: "autopilot" });
  return created;
}

async function getTarget(tx: Tx, organizationId: string, id: string) {
  const t = await tx.query.distributionTargets.findFirst({ where: and(eq(distributionTargets.id, id), eq(distributionTargets.organizationId, organizationId)) });
  if (!t) throw new Error("Not found");
  return t;
}

async function listingAsset(tx: Tx, organizationId: string, t: Target) {
  if (!t.contentAssetId) return null;
  return (await tx.query.contentAssets.findFirst({ where: and(eq(contentAssets.id, t.contentAssetId), eq(contentAssets.organizationId, organizationId)) })) ?? null;
}

/** Generate the target's UTM campaign (once) and a matching campaign row so tracker events are attributed to it. */
async function ensureCampaign(tx: Tx, organizationId: string, t: Target) {
  if (t.utmCampaign) return t.utmCampaign;
  const product = t.productId ? await tx.query.products.findFirst({ where: and(eq(products.id, t.productId), eq(products.organizationId, organizationId)) }) : null;
  const campaign = utmCampaignFor(t.name, product?.slug, randomToken(6));
  const [c] = await tx
    .insert(campaigns)
    .values({ organizationId, productId: t.productId, name: `Distribution: ${t.name}`, channel: channelFor(t.category), utmSource: utmSourceFor(t.name), utmMedium: utmMediumFor(t.category), utmCampaign: campaign, status: "ACTIVE" })
    .onConflictDoNothing()
    .returning({ id: campaigns.id });
  await tx.update(distributionTargets).set({ utmCampaign: campaign, ...(c ? { campaignId: c.id } : {}) }).where(eq(distributionTargets.id, t.id));
  return campaign;
}

/** The target's tracking link: the product's site with the target's UTM parameters (null without a product domain or campaign). */
export function trackingLinkFor(t: Pick<Target, "name" | "category" | "utmCampaign">, productDomain: string | null | undefined) {
  if (!t.utmCampaign || !productDomain) return null;
  const host = productDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return buildTrackingLink(`https://${host}/`, { source: utmSourceFor(t.name), medium: utmMediumFor(t.category), campaign: t.utmCampaign });
}

/**
 * Status transitions, enforced server-side (DISTRIBUTION_NEXT). SUBMITTED,
 * PUBLISHED and PERFORMING need a valid approval: recorded at PREPARED and
 * tied to the approved version of the listing asset. Going back (or
 * rejecting) resets the approval. Beacon never submits to third parties.
 */
export async function setDistributionStatus(
  tx: Tx,
  actor: Actor,
  id: string,
  status: DistributionStatus,
  extra: { publishedUrl?: string | null; followUpOn?: string | null; result?: string | null } = {},
) {
  const t = await getTarget(tx, actor.organizationId, id);
  assertDistributionTransition(t.status, status);
  if (REQUIRES_APPROVAL.has(status)) {
    const asset = await listingAsset(tx, actor.organizationId, t);
    if (!approvalValid(t, asset))
      throw new Error(t.submissionApprovedAt ? "The approval no longer applies: the listing changed after it was approved. Approve it again." : "An approver must approve this external submission first.");
  }
  const now = new Date();
  const reset = resetsApproval(status) && Boolean(t.submissionApprovedAt);
  await tx
    .update(distributionTargets)
    .set({
      status,
      lastAction: `Moved to ${status}`,
      lastActionAt: now,
      ...(status === "SUBMITTED" ? { submittedAt: now } : {}),
      ...(extra.publishedUrl ? { publishedUrl: extra.publishedUrl } : {}),
      ...(extra.followUpOn ? { followUpOn: extra.followUpOn } : {}),
      ...(extra.result ? { result: extra.result } : {}),
      ...(reset ? { submissionApprovedAt: null, submissionApprovedBy: null, approvedAssetId: null, approvedVersionId: null } : {}),
    })
    .where(eq(distributionTargets.id, t.id));
  if (status === "PREPARED") await ensureCampaign(tx, actor.organizationId, { ...t, status });
  await audit(tx, actor, "distribution.status", "distribution_target", t.id, { from: t.status, to: status, ...(reset ? { approvalReset: true } : {}) });
  return { ...t, status };
}

/**
 * Approve an external submission: only at PREPARED, and only for an
 * approved listing asset (directory description or outreach). The approval
 * is tied to that asset version.
 */
export async function approveSubmission(tx: Tx, actor: Actor, id: string) {
  const t = await getTarget(tx, actor.organizationId, id);
  const asset = await listingAsset(tx, actor.organizationId, t);
  const blockers = approvalBlockers(t, asset);
  if (blockers.length) throw new Error(blockers[0]);
  await tx
    .update(distributionTargets)
    .set({ submissionApprovedBy: actor.userId ?? null, submissionApprovedAt: new Date(), approvedAssetId: asset!.id, approvedVersionId: asset!.approvedVersionId, lastAction: "Submission approved", lastActionAt: new Date() })
    .where(eq(distributionTargets.id, t.id));
  await audit(tx, actor, "distribution.approve", "distribution_target", t.id, { assetId: asset!.id, versionId: asset!.approvedVersionId });
}

/**
 * "Prepare submission": creates the listing draft (directory description or
 * outreach message) through the content workflow, with the venue's
 * requirements and the tracking link in the brief, and moves a QUALIFIED
 * target to PREPARED. The draft still needs a human approval.
 */
export async function prepareSubmission(tx: Tx, actor: Actor, id: string, opts: { userId?: string | null } = {}) {
  const t = await getTarget(tx, actor.organizationId, id);
  if (t.status !== "QUALIFIED" && t.status !== "PREPARED") throw new Error("Qualify the target before preparing a submission.");
  if (!t.productId) throw new Error("Choose a product for this target first: a listing describes one product.");
  const current = await listingAsset(tx, actor.organizationId, t);
  if (current && current.status !== "REJECTED") return { asset: current, created: false };
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, t.productId), eq(products.organizationId, actor.organizationId)) });
  if (t.status === "QUALIFIED") await setDistributionStatus(tx, actor, t.id, "PREPARED");
  const campaign = await ensureCampaign(tx, actor.organizationId, await getTarget(tx, actor.organizationId, t.id));
  const link = trackingLinkFor({ ...t, utmCampaign: campaign }, product?.domain);
  const venue = venueByKey(t.catalogKey);
  const type = listingTypeFor(t.category);
  const asset = await createAsset(tx, actor, {
    productId: t.productId,
    type,
    title: `${t.name}: ${type === "OUTREACH" ? "outreach" : "listing"} for ${product?.name ?? "product"}`,
    brief: [`Venue: ${t.name}${t.url ? ` (${t.url})` : ""}`, `Requirements: ${t.requirements ?? venue?.requirements ?? "Check the venue's guidelines."}`, link ? `Tracking link: ${link}` : "", "Use verified facts only; a person submits it after approval."].filter(Boolean).join("\n"),
  });
  await tx.update(distributionTargets).set({ contentAssetId: asset.id, lastAction: "Listing draft prepared", lastActionAt: new Date() }).where(eq(distributionTargets.id, t.id));
  await enqueue("content.generate", { assetId: asset.id, userId: opts.userId ?? actor.userId ?? null, baseVersion: 0, baseStatus: "IDEA" }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:1` });
  await audit(tx, actor, "distribution.prepare", "distribution_target", t.id, { assetId: asset.id, type });
  return { asset, created: true };
}

export type TargetMeasurement = { state: "NOT_CONNECTED" | "NO_DATA_YET" | "OK"; visits: number | null; conversions: number | null };

/**
 * Traffic and conversions measured by each target's UTM campaign: visits are
 * tracker touches carrying utm_campaign; conversions are signups and
 * subscriptions whose event or attributed touch carries it. NOT_CONNECTED
 * without a tracker key for the product, NO_DATA_YET before the first visit.
 */
export async function measureTargets(tx: Tx, organizationId: string, targets: Pick<Target, "id" | "productId" | "utmCampaign">[]): Promise<Map<string, TargetMeasurement>> {
  const out = new Map<string, TargetMeasurement>();
  const withUtm = targets.filter((t) => t.utmCampaign);
  const camps = [...new Set(withUtm.map((t) => t.utmCampaign!.toLowerCase()))];
  const visits = new Map<string, number>();
  const convs = new Map<string, number>();
  if (camps.length) {
    const list = sql.join(camps.map((c) => sql`${c}`), sql`, `);
    const v = await tx.execute<{ c: string; n: number }>(sql`select lower(utm->>'campaign') as c, count(*)::int as n from attribution_events where organization_id = ${organizationId} and lower(utm->>'campaign') in (${list}) group by 1`);
    for (const r of v.rows) visits.set(r.c, Number(r.n));
    const c = await tx.execute<{ c: string; n: number }>(sql`
      select lower(coalesce(e.utm->>'campaign', a.utm->>'campaign')) as c, count(*)::int as n
      from conversion_events e left join attribution_events a on a.id = e.attribution_touch_id
      where e.organization_id = ${organizationId} and e.type::text in ('SIGNUP', 'SIGNUP_COMPLETED', 'TRIAL_STARTED', 'SUBSCRIBED', 'SUBSCRIPTION_STARTED')
        and (lower(e.utm->>'campaign') in (${list}) or lower(a.utm->>'campaign') in (${list}))
      group by 1`);
    for (const r of c.rows) convs.set(r.c, Number(r.n));
  }
  const tracker = new Map<string, boolean>();
  for (const t of targets) {
    const key = t.productId ?? "";
    if (!tracker.has(key)) tracker.set(key, (await availability(tx, organizationId, t.productId)).trackerKey);
    if (!tracker.get(key)) out.set(t.id, { state: "NOT_CONNECTED", visits: null, conversions: null });
    else if (!t.utmCampaign || !visits.get(t.utmCampaign.toLowerCase())) out.set(t.id, { state: "NO_DATA_YET", visits: null, conversions: null });
    else out.set(t.id, { state: "OK", visits: visits.get(t.utmCampaign.toLowerCase()) ?? 0, conversions: convs.get(t.utmCampaign.toLowerCase()) ?? 0 });
  }
  return out;
}

/** Approval state of each target for display: valid, reset (the listing changed), or none. */
export async function approvalStates(tx: Tx, organizationId: string, targets: Target[]) {
  const ids = [...new Set(targets.map((t) => t.contentAssetId).filter((x): x is string => Boolean(x)))];
  const assets = ids.length ? await tx.select().from(contentAssets).where(and(eq(contentAssets.organizationId, organizationId), inArray(contentAssets.id, ids))) : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  return new Map(
    targets.map((t) => {
      const asset = t.contentAssetId ? byId.get(t.contentAssetId) : undefined;
      const state = approvalValid(t, asset) ? "VALID" : t.submissionApprovedAt ? "RESET" : "NONE";
      return [t.id, { state: state as "VALID" | "RESET" | "NONE", asset: asset ?? null, blockers: approvalBlockers(t, asset) }];
    }),
  );
}

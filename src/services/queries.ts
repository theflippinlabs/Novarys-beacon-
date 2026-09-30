import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { queries, queryClusters } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { classifyQuery, INTENT_TO_FUNNEL, type Intent } from "@/core/queries/classify";
import { expandQueryUniverse } from "@/core/queries/expand";
import { normalizeQuery, slugify } from "@/core/util/text";

export async function ensureCluster(tx: Tx, organizationId: string, productId: string | null, name: string) {
  const slug = slugify(name) || "general";
  const existing = await tx.query.queryClusters.findFirst({
    where: and(eq(queryClusters.organizationId, organizationId), productId ? eq(queryClusters.productId, productId) : undefined, eq(queryClusters.slug, slug)),
  });
  if (existing) return existing;
  const [c] = await tx.insert(queryClusters).values({ organizationId, productId, name, slug }).onConflictDoNothing().returning();
  return c ?? (await tx.query.queryClusters.findFirst({ where: and(eq(queryClusters.organizationId, organizationId), eq(queryClusters.slug, slug)) }))!;
}

export type NewQuery = {
  query: string;
  productId: string | null;
  intent?: Intent;
  importance?: number;
  market?: string;
  language?: string;
  clusterName?: string;
  notes?: string;
  status?: "CANDIDATE" | "ACTIVE";
  source?: "MANUAL" | "GENERATED" | "IMPORTED" | "SEARCH_CONSOLE";
  brandTerms?: string[];
};

/** Insert a query (idempotent on normalized text + language + market). Returns null when it already existed. */
export async function addQuery(tx: Tx, organizationId: string, q: NewQuery) {
  const normalized = normalizeQuery(q.query);
  if (!normalized || normalized.length > 200) throw new Error("Query must be 1–200 characters");
  const cls = classifyQuery(normalized, q.brandTerms ?? []);
  const intent = q.intent ?? cls.intent;
  const cluster = q.clusterName ? await ensureCluster(tx, organizationId, q.productId, q.clusterName) : null;
  const [row] = await tx
    .insert(queries)
    .values({
      organizationId,
      productId: q.productId,
      clusterId: cluster?.id,
      query: q.query.trim(),
      normalized,
      intent,
      intentConfidence: q.intent ? 1 : cls.confidence,
      funnelStage: INTENT_TO_FUNNEL[intent],
      importance: Math.min(5, Math.max(1, q.importance ?? 3)),
      market: q.market || "global",
      language: q.language || "en",
      status: q.status ?? "ACTIVE",
      source: q.source ?? "MANUAL",
      notes: q.notes,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Generate the structured query universe from the knowledge graph as CANDIDATE queries for human curation. */
export async function generateQueryUniverse(tx: Tx, organizationId: string, productId: string, opts: { max?: number } = {}) {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const candidates = expandQueryUniverse(g, { max: opts.max ?? 150 });
  let inserted = 0;
  for (const c of candidates) {
    const row = await addQuery(tx, organizationId, {
      query: c.query,
      productId,
      intent: c.intent,
      clusterName: c.clusterName,
      notes: `Generated: ${c.rationale}`,
      status: "CANDIDATE",
      source: "GENERATED",
      importance: c.intent === "NAVIGATIONAL" ? 4 : 3,
      brandTerms: [g.product.name],
    });
    if (row) inserted++;
  }
  return { candidates: candidates.length, inserted };
}

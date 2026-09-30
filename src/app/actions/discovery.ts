"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { pages, products, queries, seoIssues } from "@/db/schema";
import { act, zId, zOptText } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { createAudit } from "@/services/seo";
import { syncPagePlan } from "@/services/discovery";
import { addQuery } from "@/services/queries";
import { createAssetForPage } from "@/services/content";

export async function runAuditAction(fd: FormData) {
  return act(fd, "job:run", z.object({ productId: zId, startUrl: zOptText(500), maxPages: z.coerce.number().int().min(1).max(500).default(50) }), async ({ tx, actor }, i) => {
    const a = await createAudit(tx, actor.organizationId, i.productId, { startUrl: i.startUrl ?? undefined, maxPages: i.maxPages });
    await enqueue("seo.audit", { auditId: a.id, productId: i.productId }, { organizationId: actor.organizationId, idempotencyKey: `audit:${a.id}` });
    await audit(tx, actor, "seo.audit.queue", "seo_audit", a.id, { startUrl: a.startUrl });
    return { ok: "Technical audit queued.", redirect: `/discovery/audits/${a.id}` };
  });
}

export async function syncPlanAction(fd: FormData) {
  return act(fd, "query:write", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const r = await syncPagePlan(tx, actor.organizationId, i.productId);
    return { ok: `Page plan synced: ${r.planned} planned (${r.created} new), ${r.skipped.length} skipped for insufficient facts.` };
  });
}

export async function createPageContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ pageId: zId, generate: z.string().optional() }), async ({ tx, actor }, i) => {
    const asset = await createAssetForPage(tx, actor, i.pageId);
    if (i.generate) await enqueue("content.generate", { assetId: asset.id, userId: actor.userId }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:${asset.currentVersion + 1}` });
    return { redirect: `/content/${asset.id}`, ok: i.generate ? "Draft generation queued." : "Content asset created." };
  });
}

export async function setIssueStatusAction(fd: FormData) {
  return act(fd, "query:write", z.object({ id: zId, status: z.enum(["OPEN", "RESOLVED", "IGNORED"]) }), async ({ tx, actor }, i) => {
    await tx.update(seoIssues).set({ status: i.status }).where(and(eq(seoIssues.id, i.id), eq(seoIssues.organizationId, actor.organizationId)));
    return { ok: `Issue marked ${i.status.toLowerCase()}.` };
  });
}

export async function archivePageAction(fd: FormData) {
  return act(fd, "content:write", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await tx.update(pages).set({ status: "ARCHIVED" }).where(and(eq(pages.id, i.id), eq(pages.organizationId, actor.organizationId)));
    return { ok: "Page archived." };
  });
}

// ── Queries ─────────────────────────────────────────────────────────────
const INTENT = z.enum(["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL", "COMPARISON", "PROBLEM", "ALTERNATIVE"]);

export async function addQueryAction(fd: FormData) {
  return act(
    fd,
    "query:write",
    z.object({
      query: z.string().trim().min(2).max(200),
      productId: z.union([zId, z.literal("")]),
      intent: z.union([INTENT, z.literal("")]).optional(),
      importance: z.coerce.number().int().min(1).max(5).default(3),
      market: z.string().trim().max(40).default("global"),
      language: z.string().trim().max(10).default("en"),
      cluster: zOptText(80),
      notes: zOptText(500),
    }),
    async ({ tx, actor }, i) => {
      const product = i.productId ? await tx.query.products.findFirst({ where: and(eq(products.id, i.productId), eq(products.organizationId, actor.organizationId)) }) : null;
      const row = await addQuery(tx, actor.organizationId, {
        query: i.query,
        productId: product?.id ?? null,
        intent: i.intent || undefined,
        importance: i.importance,
        market: i.market,
        language: i.language,
        clusterName: i.cluster ?? undefined,
        notes: i.notes ?? undefined,
        brandTerms: product ? [product.name] : [],
      });
      if (!row) throw new Error("That query already exists for this market and language.");
      await audit(tx, actor, "query.add", "query", row.id, { query: row.query, intent: row.intent });
      return { ok: `Added "${row.query}" (${row.intent.toLowerCase()}, ${row.funnelStage.toLowerCase()}).` };
    },
  );
}

export async function generateQueriesAction(fd: FormData) {
  return act(fd, "query:write", z.object({ productId: zId }), async ({ actor }, i) => {
    await enqueue("queries.generate", { productId: i.productId }, { organizationId: actor.organizationId, idempotencyKey: `qgen:${i.productId}:${Math.floor(Date.now() / 60_000)}` });
    return { ok: "Query universe generation queued. New queries arrive as CANDIDATE for curation." };
  });
}

export async function bulkQueryAction(fd: FormData) {
  return act(fd, "query:write", z.object({ ids: z.array(zId).min(1).max(500), op: z.enum(["ACTIVE", "ARCHIVED", "CANDIDATE", "imp1", "imp3", "imp5"]) }), async ({ tx, actor }, i) => {
    const where = and(eq(queries.organizationId, actor.organizationId), inArray(queries.id, i.ids));
    if (i.op.startsWith("imp")) await tx.update(queries).set({ importance: Number(i.op.slice(3)) }).where(where);
    else await tx.update(queries).set({ status: i.op as "ACTIVE" | "ARCHIVED" | "CANDIDATE" }).where(where);
    await audit(tx, actor, "query.bulk", "query", null, { op: i.op, count: i.ids.length });
    return { ok: `Updated ${i.ids.length} quer${i.ids.length === 1 ? "y" : "ies"}.` };
  });
}

export async function updateQueryAction(fd: FormData) {
  return act(fd, "query:write", z.object({ id: zId, intent: INTENT, importance: z.coerce.number().int().min(1).max(5), notes: zOptText(500) }), async ({ tx, actor }, i) => {
    const { INTENT_TO_FUNNEL } = await import("@/core/queries/classify");
    await tx
      .update(queries)
      .set({ intent: i.intent, intentConfidence: 1, funnelStage: INTENT_TO_FUNNEL[i.intent], importance: i.importance, notes: i.notes })
      .where(and(eq(queries.id, i.id), eq(queries.organizationId, actor.organizationId)));
    return { ok: "Query updated." };
  });
}

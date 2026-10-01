import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, products, searchDaily } from "@/db/schema";
import type { MetricRow, SearchRow } from "@/integrations/types";
import type { SearchProvider } from "@/integrations/registry";

export type SearchTarget = { organizationId: string; productId: string | null; integrationId: string; provider: SearchProvider };

const rowKey = (r: SearchRow) => [r.day, r.query ?? "\u0000", r.page ?? "\u0000", r.country ?? "\u0000", r.device ?? "\u0000"].join("\u0001");

/**
 * Merge rows sharing the same key inside one batch (a provider can return
 * several rows for one key; Postgres refuses to update a row twice in one
 * statement). Clicks and impressions add up, position stays weighted.
 */
export function dedupeSearchRows(rows: SearchRow[]): SearchRow[] {
  const map = new Map<string, SearchRow & { posW: number; posSum: number }>();
  for (const r of rows) {
    const k = rowKey(r);
    const cur = map.get(k);
    const posW = r.position !== null ? r.impressions : 0;
    const posSum = r.position !== null ? r.position * r.impressions : 0;
    if (!cur) map.set(k, { ...r, posW, posSum });
    else {
      cur.clicks += r.clicks;
      cur.impressions += r.impressions;
      cur.posW += posW;
      cur.posSum += posSum;
    }
  }
  return [...map.values()].map(({ posW, posSum, ...r }) => ({
    ...r,
    ctr: r.impressions ? r.clicks / r.impressions : 0,
    position: posW > 0 ? posSum / posW : r.position,
  }));
}

/**
 * Upsert normalized rows. The unique key (integration, day, query, page,
 * country, device; NULLS NOT DISTINCT) makes re-imports of the same days
 * replace values instead of adding them: overlapping syncs never double count.
 */
export async function upsertSearchRows(tx: Tx, target: SearchTarget, rows: SearchRow[]): Promise<number> {
  const clean = dedupeSearchRows(rows);
  for (let i = 0; i < clean.length; i += 1000) {
    const chunk = clean.slice(i, i + 1000);
    await tx
      .insert(searchDaily)
      .values(chunk.map((r) => ({ ...target, day: r.day, query: r.query, page: r.page, country: r.country, device: r.device, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })))
      .onConflictDoUpdate({
        target: [searchDaily.integrationId, searchDaily.day, searchDaily.query, searchDaily.page, searchDaily.country, searchDaily.device],
        set: { clicks: sql`excluded.clicks`, impressions: sql`excluded.impressions`, ctr: sql`excluded.ctr`, position: sql`excluded.position`, productId: sql`excluded.product_id`, importedAt: sql`now()` },
      });
  }
  return clean.length;
}

/** Daily totals (rows without any dimension) as the visibility_metrics series the KPIs read. */
export function searchTotalsAsMetrics(rows: SearchRow[]): MetricRow[] {
  const out: MetricRow[] = [];
  for (const r of dedupeSearchRows(rows)) {
    if (r.query || r.page || r.country || r.device) continue;
    out.push({ metric: "search_impressions", day: r.day, value: r.impressions });
    out.push({ metric: "search_clicks", day: r.day, value: r.clicks });
    if (r.position !== null) out.push({ metric: "search_position", day: r.day, value: r.position, weight: r.impressions });
  }
  return out;
}

/**
 * Page-to-product mapping. An explicit `urlPrefix` in the integration config
 * wins. Otherwise, when the same property is connected for several products,
 * each product only keeps pages under its own domain. A property used by a
 * single product keeps all its pages.
 */
export async function resolvePagePrefix(tx: Tx, integ: typeof integrations.$inferSelect): Promise<string | null> {
  if (integ.config.urlPrefix) return integ.config.urlPrefix;
  if (!integ.productId || !integ.config.siteUrl) return null;
  const siblings = await tx
    .select({ id: integrations.id, config: integrations.config })
    .from(integrations)
    .where(and(eq(integrations.organizationId, integ.organizationId), eq(integrations.provider, integ.provider), ne(integrations.id, integ.id)));
  if (!siblings.some((s) => s.config.siteUrl === integ.config.siteUrl)) return null;
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, integ.productId), eq(products.organizationId, integ.organizationId)) });
  if (!p?.domain) return null;
  return /^https?:\/\//i.test(p.domain) ? (p.domain.endsWith("/") ? p.domain : `${p.domain}/`) : `https://${p.domain.replace(/\/+$/, "")}/`;
}

/** Remove imported rows of an integration (its property or page mapping changed). */
export async function clearSearchRows(tx: Tx, organizationId: string, integrationId: string) {
  await tx.delete(searchDaily).where(and(eq(searchDaily.organizationId, organizationId), eq(searchDaily.integrationId, integrationId)));
}

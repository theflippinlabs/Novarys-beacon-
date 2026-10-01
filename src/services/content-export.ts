import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, contentVersions, products } from "@/db/schema";
import { exportBaseName, exportFiles, exportSingleMarkdown, type ExportInput } from "@/core/content/export";
import { zipStore } from "@/core/util/zip";
import { audit, type Actor } from "@/lib/audit";

export type ExportFormat = "zip" | "md";

/**
 * Production-ready export of the approved version of an asset (the published
 * one when the asset was published and then edited). Refused for content
 * that no person has approved. Audited.
 */
export async function exportApprovedAsset(tx: Tx, actor: Actor, assetId: string, format: ExportFormat, now = new Date()) {
  const asset = await tx.query.contentAssets.findFirst({ where: and(eq(contentAssets.id, assetId), eq(contentAssets.organizationId, actor.organizationId)) });
  if (!asset) throw new Error("Content asset not found");
  const versionId = asset.status === "APPROVED" ? asset.approvedVersionId : (asset.publishedVersionId ?? (asset.status === "PUBLISHED" ? asset.approvedVersionId : null));
  if (!versionId) throw new Error("Only approved or published content can be exported.");
  const v = await tx.query.contentVersions.findFirst({ where: and(eq(contentVersions.id, versionId), eq(contentVersions.organizationId, actor.organizationId)) });
  if (!v) throw new Error("Version not found");
  const product = asset.productId ? await tx.query.products.findFirst({ where: and(eq(products.id, asset.productId), eq(products.organizationId, actor.organizationId)), columns: { name: true, slug: true } }) : null;
  const input: ExportInput = {
    asset: { id: asset.id, title: asset.title, type: asset.type, status: asset.status, approvedAt: asset.approvedAt },
    version: { version: v.version, body: v.body, metaTitle: v.metaTitle, metaDescription: v.metaDescription, structuredData: v.structuredData, factRefs: v.factRefs },
    product: product ?? null,
    exportedAt: now,
  };
  await audit(tx, actor, "content.export", "content_asset", asset.id, { version: v.version, format });
  const base = exportBaseName(input);
  if (format === "md") return { filename: `${base}.md`, contentType: "text/markdown; charset=utf-8", body: new TextEncoder().encode(exportSingleMarkdown(input)) };
  return { filename: `${base}.zip`, contentType: "application/zip", body: zipStore(exportFiles(input), now) };
}

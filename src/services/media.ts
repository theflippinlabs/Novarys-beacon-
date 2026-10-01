import "server-only";
import sharp, { type Metadata } from "sharp";
import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, media, organizations, products } from "@/db/schema";
import { audit, type Actor } from "@/lib/audit";
import { env } from "@/lib/env";
import { buildMediaUrl, isUuid, sniffImage } from "@/core/media/image";

/** Largest accepted upload (before re-encoding). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** Longest side of a stored image. */
export const MAX_DIMENSION = 2048;
/** Decompression-bomb guard: refuse inputs above this many pixels (a 48 MP phone photo fits). */
export const MAX_INPUT_PIXELS = 70_000_000;

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "heif", "avif", "tiff"]);

export const MEDIA_ERRORS = {
  empty: "The file is empty.",
  tooLarge: "The image is too large (15 MB maximum).",
  unsupported: "Unsupported file type. Upload a JPEG, PNG, WebP, GIF, AVIF, HEIC or TIFF image.",
  unreadable: "The image could not be read. If it is a HEIC photo, export it as JPEG and try again.",
  tooManyPixels: "The image dimensions are too large.",
  notFound: "Image not found.",
  notPublic: "Only public images can be used as a logo.",
} as const;

export type MediaInput = {
  data: Buffer;
  filename: string;
  productId?: string | null;
  contentAssetId?: string | null;
  visibility?: "PUBLIC" | "PRIVATE";
  alt?: string | null;
};

export function mediaUrl(id: string, absolute = false): string {
  return buildMediaUrl(id, absolute ? env().BEACON_BASE_URL : null);
}

function storedFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "_")
    .trim()
    .slice(0, 150);
  return `${base || "image"}.webp`;
}

/** Decodes, auto-orients, downsizes and re-encodes to WebP. All metadata (EXIF, GPS, XMP, ICC) is dropped. */
async function reencode(data: Buffer): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (!data.length) throw new Error(MEDIA_ERRORS.empty);
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(MEDIA_ERRORS.tooLarge);
  if (!sniffImage(data)) throw new Error(MEDIA_ERRORS.unsupported);
  const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" as const };
  let meta: Metadata;
  try {
    meta = await sharp(data, opts).metadata();
  } catch {
    throw new Error(MEDIA_ERRORS.unreadable);
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw new Error(MEDIA_ERRORS.unsupported);
  if (!meta.width || !meta.height) throw new Error(MEDIA_ERRORS.unreadable);
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new Error(MEDIA_ERRORS.tooManyPixels);
  try {
    const { data: bytes, info } = await sharp(data, opts)
      .autoOrient()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { bytes, width: info.width, height: info.height };
  } catch (e) {
    if (/pixel limit/i.test((e as Error).message)) throw new Error(MEDIA_ERRORS.tooManyPixels);
    throw new Error(MEDIA_ERRORS.unreadable);
  }
}

async function assertProduct(tx: Tx, organizationId: string, productId: string) {
  const p = isUuid(productId) ? await tx.query.products.findFirst({ columns: { id: true }, where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) }) : null;
  if (!p) throw new Error("Product not found");
}

async function assertContentAsset(tx: Tx, organizationId: string, assetId: string) {
  const a = isUuid(assetId) ? await tx.query.contentAssets.findFirst({ columns: { id: true }, where: and(eq(contentAssets.id, assetId), eq(contentAssets.organizationId, organizationId)) }) : null;
  if (!a) throw new Error("Content asset not found");
}

/**
 * Validates and stores an uploaded image for `actor.organizationId`. The
 * original bytes are never kept: only the re-encoded, metadata-free WebP.
 */
export async function ingestImage(tx: Tx, actor: Actor, input: MediaInput): Promise<{ id: string; url: string; width: number; height: number; sizeBytes: number }> {
  const productId = input.productId || null;
  const contentAssetId = input.contentAssetId || null;
  if (productId) await assertProduct(tx, actor.organizationId, productId);
  if (contentAssetId) await assertContentAsset(tx, actor.organizationId, contentAssetId);
  const img = await reencode(input.data);
  const alt = input.alt?.trim().slice(0, 300) || null;
  const [row] = await tx
    .insert(media)
    .values({
      organizationId: actor.organizationId,
      productId,
      contentAssetId,
      visibility: input.visibility ?? "PUBLIC",
      filename: storedFilename(input.filename),
      mime: "image/webp",
      width: img.width,
      height: img.height,
      sizeBytes: img.bytes.length,
      alt,
      bytes: img.bytes,
      createdBy: actor.actorType === "USER" || !actor.actorType ? (actor.userId ?? null) : null,
    })
    .returning({ id: media.id });
  await audit(tx, actor, "media.upload", "media", row.id, { productId, contentAssetId, visibility: input.visibility ?? "PUBLIC", width: img.width, height: img.height, sizeBytes: img.bytes.length });
  return { id: row.id, url: mediaUrl(row.id), width: img.width, height: img.height, sizeBytes: img.bytes.length };
}

/** One media row including its bytes, or null (also for malformed ids). */
export async function loadMedia(tx: Tx, organizationId: string, id: string) {
  if (!isUuid(id)) return null;
  return (await tx.query.media.findFirst({ where: and(eq(media.id, id), eq(media.organizationId, organizationId)) })) ?? null;
}

const LIST_COLUMNS = {
  id: media.id,
  productId: media.productId,
  contentAssetId: media.contentAssetId,
  visibility: media.visibility,
  filename: media.filename,
  width: media.width,
  height: media.height,
  sizeBytes: media.sizeBytes,
  alt: media.alt,
  createdAt: media.createdAt,
};

/** Media metadata (no bytes), newest first, optionally filtered by product or content asset. */
export async function listMedia(tx: Tx, organizationId: string, filter: { productId?: string; contentAssetId?: string } = {}, limit = 60) {
  const where: SQL[] = [eq(media.organizationId, organizationId)];
  if (filter.productId) where.push(eq(media.productId, filter.productId));
  if (filter.contentAssetId) where.push(eq(media.contentAssetId, filter.contentAssetId));
  return tx.select(LIST_COLUMNS).from(media).where(and(...where)).orderBy(desc(media.createdAt)).limit(limit);
}

async function requireMedia(tx: Tx, organizationId: string, id: string) {
  const row = isUuid(id) ? await tx.select({ id: media.id, visibility: media.visibility, productId: media.productId }).from(media).where(and(eq(media.id, id), eq(media.organizationId, organizationId))).limit(1) : [];
  if (!row[0]) throw new Error(MEDIA_ERRORS.notFound);
  return row[0];
}

/** Uses an uploaded (PUBLIC) image as the product logo; the logo URL is absolute so it works in JSON-LD and exports. */
export async function setProductLogo(tx: Tx, actor: Actor, productId: string, mediaId: string) {
  await assertProduct(tx, actor.organizationId, productId);
  const m = await requireMedia(tx, actor.organizationId, mediaId);
  if (m.visibility !== "PUBLIC") throw new Error(MEDIA_ERRORS.notPublic);
  const logoUrl = mediaUrl(m.id, true);
  await tx.update(products).set({ logoUrl, updatedAt: new Date() }).where(and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)));
  if (!m.productId) await tx.update(media).set({ productId }).where(and(eq(media.id, m.id), isNull(media.productId)));
  await audit(tx, actor, "product.logo", "product", productId, { mediaId: m.id });
  return { logoUrl };
}

/** Uses an uploaded (PUBLIC) image as the organisation logo (branding.logoUrl). */
export async function setOrgLogo(tx: Tx, actor: Actor, mediaId: string) {
  const m = await requireMedia(tx, actor.organizationId, mediaId);
  if (m.visibility !== "PUBLIC") throw new Error(MEDIA_ERRORS.notPublic);
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
  if (!org) throw new Error("Organisation not found");
  const logoUrl = mediaUrl(m.id, true);
  await tx.update(organizations).set({ branding: { ...org.branding, logoUrl } }).where(eq(organizations.id, org.id));
  await audit(tx, actor, "org.logo", "organization", org.id, { mediaId: m.id });
  return { logoUrl };
}

/** Deletes an image and clears any product or organisation logo that points at it. */
export async function deleteMedia(tx: Tx, actor: Actor, id: string) {
  const m = await requireMedia(tx, actor.organizationId, id);
  const urls = [mediaUrl(m.id), mediaUrl(m.id, true)];
  await tx
    .update(products)
    .set({ logoUrl: null, updatedAt: new Date() })
    .where(and(eq(products.organizationId, actor.organizationId), inArray(products.logoUrl, urls)));
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
  if (org?.branding.logoUrl && urls.includes(org.branding.logoUrl)) {
    const { logoUrl: _removed, ...branding } = org.branding;
    void _removed;
    await tx.update(organizations).set({ branding }).where(eq(organizations.id, org.id));
  }
  await tx.delete(media).where(and(eq(media.id, m.id), eq(media.organizationId, actor.organizationId)));
  await audit(tx, actor, "media.delete", "media", m.id, {});
}

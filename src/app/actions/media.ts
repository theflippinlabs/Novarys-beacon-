"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { contentAssets, media, organizations } from "@/db/schema";
import { act, zCheckbox, zId } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/rbac";
import { altFromFilename, mediaIdFromUrl } from "@/core/media/image";
import { env } from "@/lib/env";
import type { Tx } from "@/db";
import { deleteMedia, ingestImage, MAX_UPLOAD_BYTES, MEDIA_ERRORS, setOrgLogo, setProductLogo } from "@/services/media";

/** Most images accepted in one submit (the client downsizes them first; see next.config bodySizeLimit). */
const MAX_FILES = 12;

/** Uploaded files from the form. `act()` only sees file names, so the bytes are read here. */
async function readFiles(fd: FormData, max = MAX_FILES): Promise<{ data: Buffer; filename: string }[]> {
  const files = fd.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (!files.length) throw new Error("Choose at least one image.");
  if (files.length > max) throw new Error(max === 1 ? "Choose a single image." : "You can upload up to 12 images at a time.");
  const out: { data: Buffer; filename: string }[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) throw new Error(MEDIA_ERRORS.tooLarge);
    out.push({ data: Buffer.from(await f.arrayBuffer()), filename: f.name || "image" });
  }
  return out;
}

/** Product photos (several at once). With `asLogo`, the first uploaded image becomes the product logo. */
export async function uploadProductPhotosAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, asLogo: zCheckbox }), async ({ tx, actor }, i) => {
    const files = await readFiles(fd, i.asLogo ? 1 : MAX_FILES);
    const ids: string[] = [];
    for (const f of files) ids.push((await ingestImage(tx, actor, { ...f, productId: i.productId, visibility: "PUBLIC", alt: altFromFilename(f.filename) })).id);
    if (i.asLogo) {
      await setProductLogo(tx, actor, i.productId, ids[0]);
      return { ok: "Logo uploaded." };
    }
    return { ok: ids.length === 1 ? "Photo uploaded." : `${ids.length} photos uploaded.` };
  });
}

export async function setProductLogoAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, mediaId: zId }), async ({ tx, actor }, i) => {
    await setProductLogo(tx, actor, i.productId, i.mediaId);
    return { ok: "Logo updated." };
  });
}

/** Deletes a product photo or content image. Organisation-level images (no product or content) need settings:manage. */
export async function deleteMediaAction(fd: FormData) {
  return act(fd, "product:write", z.object({ mediaId: zId }), async ({ tx, actor, ctx }, i) => {
    const [m] = await tx.select({ productId: media.productId, contentAssetId: media.contentAssetId }).from(media).where(and(eq(media.id, i.mediaId), eq(media.organizationId, actor.organizationId))).limit(1);
    if (!m) throw new Error(MEDIA_ERRORS.notFound);
    if (m.contentAssetId && !can(ctx.role, "content:write")) throw new Error("You do not have permission to do that.");
    if (!m.productId && !m.contentAssetId && !can(ctx.role, "settings:manage")) throw new Error("You do not have permission to do that.");
    await deleteMedia(tx, actor, i.mediaId);
    return { ok: "Image deleted." };
  });
}

/** Images for a content asset; the editor then references them in the draft as Markdown. */
export async function uploadContentImagesAction(fd: FormData) {
  return act(fd, "content:write", z.object({ assetId: zId }), async ({ tx, actor }, i) => {
    const asset = await tx.query.contentAssets.findFirst({ columns: { id: true }, where: and(eq(contentAssets.id, i.assetId), eq(contentAssets.organizationId, actor.organizationId)) });
    if (!asset) throw new Error("Content asset not found");
    const files = await readFiles(fd);
    for (const f of files) await ingestImage(tx, actor, { ...f, contentAssetId: asset.id, visibility: "PUBLIC", alt: altFromFilename(f.filename) });
    return { ok: files.length === 1 ? "Image uploaded." : `${files.length} images uploaded.` };
  });
}

export async function uploadOrgLogoAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({}), async ({ tx, actor }) => {
    const [f] = await readFiles(fd, 1);
    const img = await ingestImage(tx, actor, { ...f, visibility: "PUBLIC", alt: altFromFilename(f.filename) });
    await setOrgLogo(tx, actor, img.id);
    return { ok: "Logo uploaded." };
  });
}

/** Removes the organisation logo; an uploaded logo image is deleted with it. */
export async function removeOrgLogoAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({}), async ({ tx, actor }) => {
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
    if (!org) throw new Error("Organisation not found");
    const id = org.branding.logoUrl ? mediaIdFromUrl(org.branding.logoUrl, [env().BEACON_BASE_URL]) : null;
    if (id && (await loadMediaMeta(tx, actor.organizationId, id))) {
      await deleteMedia(tx, actor, id);
    } else {
      const { logoUrl: _removed, ...branding } = org.branding;
      void _removed;
      await tx.update(organizations).set({ branding }).where(eq(organizations.id, org.id));
      await audit(tx, actor, "org.logo", "organization", org.id, { removed: true });
    }
    return { ok: "Logo removed." };
  });
}

async function loadMediaMeta(tx: Tx, organizationId: string, id: string) {
  const [m] = await tx.select({ id: media.id }).from(media).where(and(eq(media.id, id), eq(media.organizationId, organizationId))).limit(1);
  return m ?? null;
}

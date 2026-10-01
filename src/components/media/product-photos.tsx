import { deleteMediaAction, setProductLogoAction, uploadProductPhotosAction } from "@/app/actions/media";
import { Badge, HiddenBack, Panel } from "@/components/ui";
import { ConfirmSubmit, PendingSubmit } from "@/components/media/media-controls";
import { PhotoUpload } from "@/components/media/photo-upload";
import { mediaIdFromUrl, buildMediaUrl } from "@/core/media/image";
import { env } from "@/lib/env";
import { getT } from "@/i18n/server";

type Photo = { id: string; filename: string; alt: string | null; width: number; height: number };

/** Product dashboard "Photos" panel: grid, upload, use as logo, delete. */
export async function ProductPhotos({ product, photos, canEdit, back }: { product: { id: string; name: string; logoUrl: string | null }; photos: Photo[]; canEdit: boolean; back: string }) {
  const t = await getT();
  const logoId = product.logoUrl ? mediaIdFromUrl(product.logoUrl, [env().BEACON_BASE_URL]) : null;
  const externalLogo = product.logoUrl && !logoId ? product.logoUrl : null;
  return (
    <Panel title={t("Photos")} eyebrow={t("Media")} className="mt-6">
      <div id="photos" className="flex scroll-mt-24 flex-col gap-5">
        {photos.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {photos.map((ph) => {
              const isLogo = ph.id === logoId;
              return (
                <li key={ph.id} className={`flex flex-col border bg-obsidian ${isLogo ? "border-gold" : "border-line"}`}>
                  <a href={buildMediaUrl(ph.id)} target="_blank" rel="noopener noreferrer" className="relative block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={buildMediaUrl(ph.id)} alt={ph.alt ?? ""} width={ph.width} height={ph.height} loading="lazy" className="aspect-square w-full object-cover" />
                    {isLogo && (
                      <span className="absolute left-1.5 top-1.5">
                        <Badge tone="gold">★ {t("Logo")}</Badge>
                      </span>
                    )}
                  </a>
                  <div className="flex flex-col gap-2 p-2">
                    <span className="num truncate text-[10px] text-muted" title={ph.filename}>
                      {ph.width}×{ph.height}
                    </span>
                    {canEdit && (
                      <div className="flex flex-wrap gap-1.5">
                        {!isLogo && (
                          <form action={setProductLogoAction}>
                            <HiddenBack path={back} />
                            <input type="hidden" name="productId" value={product.id} />
                            <input type="hidden" name="mediaId" value={ph.id} />
                            <PendingSubmit>{t("Use as logo")}</PendingSubmit>
                          </form>
                        )}
                        <form action={deleteMediaAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="mediaId" value={ph.id} />
                          <ConfirmSubmit message={isLogo ? t("Delete this image? It is the current logo and will be removed from the product.") : t("Delete this image?")}>{t("Delete")}</ConfirmSubmit>
                        </form>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No photos yet. Add product screenshots, photos or a logo — they can be used on pages and in content.")}</p>
        )}
        {externalLogo && (
          <p className="text-xs text-muted">
            {t("Current logo URL:")} <span className="num break-all">{externalLogo}</span>
          </p>
        )}
        {canEdit && (
          <PhotoUpload key={photos[0]?.id ?? "none"} action={uploadProductPhotosAction} kind="photos">
            <HiddenBack path={back} />
            <input type="hidden" name="productId" value={product.id} />
          </PhotoUpload>
        )}
      </div>
    </Panel>
  );
}

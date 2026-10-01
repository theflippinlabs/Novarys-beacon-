import { deleteMediaAction, uploadContentImagesAction } from "@/app/actions/media";
import { HiddenBack, Panel } from "@/components/ui";
import { ConfirmSubmit, CopyButton, InsertButton } from "@/components/media/media-controls";
import { PhotoUpload } from "@/components/media/photo-upload";
import { buildMediaUrl, markdownImage } from "@/core/media/image";
import { mediaUrl } from "@/services/media";
import { getT } from "@/i18n/server";

type Image = { id: string; filename: string; alt: string | null; width: number; height: number };

/** Content asset "Images" panel: upload images and reference them in the draft as Markdown. */
export async function ContentImages({ assetId, images, canEdit, editorId, back }: { assetId: string; images: Image[]; canEdit: boolean; editorId: string | null; back: string }) {
  const t = await getT();
  return (
    <Panel title={t("Images")} eyebrow={t("Media")}>
      <div id="images" className="flex scroll-mt-24 flex-col gap-4">
        {images.length ? (
          <ul className="flex flex-col gap-3">
            {images.map((im) => {
              const snippet = markdownImage(im.alt || im.filename.replace(/\.webp$/, ""), mediaUrl(im.id, true));
              return (
                <li key={im.id} className="flex flex-col gap-3 border border-line bg-obsidian p-2 sm:flex-row">
                  <a href={buildMediaUrl(im.id)} target="_blank" rel="noopener noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={buildMediaUrl(im.id)} alt={im.alt ?? ""} width={im.width} height={im.height} loading="lazy" className="h-28 w-full object-cover sm:w-36" />
                  </a>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <code className="block break-all border border-line bg-panel px-2 py-1.5 font-mono text-[11px] text-chrome">{snippet}</code>
                    <div className="flex flex-wrap gap-1.5">
                      <CopyButton text={snippet} label={t("Copy Markdown")} />
                      {editorId && <InsertButton text={snippet} targetId={editorId} />}
                      {canEdit && (
                        <form action={deleteMediaAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="mediaId" value={im.id} />
                          <ConfirmSubmit message={t("Delete this image?")}>{t("Delete")}</ConfirmSubmit>
                        </form>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No images yet. Uploaded images can be placed in the draft with Markdown.")}</p>
        )}
        {images.length > 0 && <p className="text-[11px] text-muted">{t("Images are not facts: the fact check reads only their alt text. Save a new version after inserting an image.")}</p>}
        {canEdit && (
          <PhotoUpload key={images[0]?.id ?? "none"} action={uploadContentImagesAction} kind="images">
            <HiddenBack path={back} />
            <input type="hidden" name="assetId" value={assetId} />
          </PhotoUpload>
        )}
      </div>
    </Panel>
  );
}

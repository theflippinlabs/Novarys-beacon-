/**
 * Pure helpers for uploaded images. No I/O: the service layer (src/services/media.ts)
 * decodes and re-encodes with sharp; these functions decide what is acceptable.
 */

export type RasterKind = "jpeg" | "png" | "gif" | "webp" | "tiff" | "heif";

/** Path prefix under which uploaded media is served. */
export const MEDIA_PATH = "/api/media/";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

/**
 * Identifies a raster image from its magic bytes. Returns null for anything
 * else (including SVG, which is XML that can carry script, PDF and HTML), so those
 * never reach the decoder.
 */
export function sniffImage(buf: Uint8Array): RasterKind | null {
  if (buf.length < 12) return null;
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && ascii(1, 4) === "PNG" && buf[4] === 0x0d && buf[5] === 0x0a) return "png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return "tiff";
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12).toLowerCase())) return "heif";
  return null;
}

/** Relative (`/api/media/<id>`) or absolute (`<base>/api/media/<id>`) media URL. */
export function buildMediaUrl(id: string, base?: string | null): string {
  return `${base ? base.replace(/\/+$/, "") : ""}${MEDIA_PATH}${id}`;
}

/**
 * Returns the media id when `src` points at this site's media endpoint
 * (either site-relative or absolute on one of `origins`), else null.
 */
export function mediaIdFromUrl(src: string, origins: readonly string[] = []): string | null {
  let path: string;
  if (src.startsWith(MEDIA_PATH)) path = src;
  else {
    let u: URL;
    try {
      u = new URL(src);
    } catch {
      return null;
    }
    if (!origins.some((o) => safeOrigin(o) === u.origin)) return null;
    if (u.search || u.hash) return null;
    path = u.pathname;
  }
  const id = path.slice(MEDIA_PATH.length);
  return path.startsWith(MEDIA_PATH) && isUuid(id) ? id.toLowerCase() : null;
}

function safeOrigin(o: string): string | null {
  try {
    return new URL(o).origin;
  } catch {
    return null;
  }
}

/** Markdown image snippet; brackets/parentheses in the alt text are neutralised. */
export function markdownImage(alt: string, url: string): string {
  const clean = alt.replace(/[[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return `![${clean}](${url})`;
}

/** Turns an uploaded filename into a default alt text ("IMG_0042.HEIC" → "IMG 0042"). */
export function altFromFilename(name: string): string {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Prefix of every media object in object storage. */
export const MEDIA_STORAGE_PREFIX = "media/";

/** Object storage key of one image: `media/{organizationId}/{mediaId}.webp` (both lowercased UUIDs). */
export function mediaStorageKey(organizationId: string, mediaId: string): string {
  if (!isUuid(organizationId) || !isUuid(mediaId)) throw new Error("Invalid media storage key ids");
  return `${MEDIA_STORAGE_PREFIX}${organizationId.toLowerCase()}/${mediaId.toLowerCase()}.webp`;
}

/** Inverse of `mediaStorageKey`; null for any key Beacon did not build. */
export function parseMediaStorageKey(key: string): { organizationId: string; mediaId: string } | null {
  const m = /^media\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.webp$/.exec(key);
  if (!m || !isUuid(m[1]) || !isUuid(m[2])) return null;
  return { organizationId: m[1], mediaId: m[2] };
}

/**
 * Keyset (cursor) pagination helpers (pure). A cursor is the sort value and
 * id of the last row of a page, encoded as opaque base64url JSON. Lists are
 * fetched with `limit + 1` rows to know whether a next page exists.
 */
export const PAGE_SIZE = 50;

export type Cursor = { v: string | number; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.v, c.id]), "utf8").toString("base64url");
}

/** The cursor in a query parameter, or null when absent or malformed (never throws). */
export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw || raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [v, id] = parsed as [unknown, unknown];
    if (typeof id !== "string" || !UUID.test(id)) return null;
    if (typeof v === "number" && Number.isFinite(v)) return { v, id };
    if (typeof v === "string" && v.length <= 300) return { v, id };
    return null;
  } catch {
    return null;
  }
}

/** Cuts a `limit + 1` fetch into a page and the cursor of the next one. */
export function pageOf<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor): { items: T[]; next: string | null } {
  if (rows.length <= limit) return { items: rows, next: null };
  const items = rows.slice(0, limit);
  return { items, next: encodeCursor(cursorOf(items[items.length - 1])) };
}

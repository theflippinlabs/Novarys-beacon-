import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Cursor } from "@/core/util/cursor";

/**
 * Keyset condition: rows strictly after `cursor` in (sortCol, idCol) order.
 * The sort value is compared as text, number or timestamp to match the column.
 */
export function afterCursor(sortCol: AnyPgColumn, idCol: AnyPgColumn, cursor: Cursor | null, dir: "asc" | "desc", kind: "text" | "number" | "timestamp" = "text"): SQL | undefined {
  if (!cursor) return undefined;
  // Timestamps are compared at millisecond precision (what a JS Date keeps); order with `msKey` to match.
  const col = kind === "timestamp" ? msKey(sortCol) : sql`${sortCol}`;
  const v = kind === "timestamp" ? sql`${String(cursor.v)}::timestamptz` : kind === "number" ? sql`${Number(cursor.v)}` : sql`${String(cursor.v)}`;
  return dir === "asc" ? sql`(${col}, ${idCol}) > (${v}, ${cursor.id}::uuid)` : sql`(${col}, ${idCol}) < (${v}, ${cursor.id}::uuid)`;
}

export const tsCursor = (d: Date, id: string): Cursor => ({ v: d.toISOString(), id });

/** A timestamp column truncated to milliseconds, for ORDER BY in keyset-paginated lists. */
export const msKey = (col: AnyPgColumn) => sql`date_trunc('milliseconds', ${col})`;

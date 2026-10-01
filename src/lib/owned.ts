import { and, eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Tx } from "@/db";

type OwnedTable = PgTable & { id: PgColumn; organizationId: PgColumn };

export class NotOwnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotOwnedError";
  }
}

/**
 * Reject an id taken from a form unless it names a row of `table` owned by
 * `organizationId`. Postgres foreign keys ignore row-level security, so
 * without this check a member could attach another tenant's product, source,
 * affiliate or campaign id to their own rows. Empty ids (optional references)
 * pass. Throws with a user-facing message (`notFound`).
 */
export async function assertOwned(tx: Tx, table: OwnedTable, id: string | null | undefined, organizationId: string, notFound = "Not found"): Promise<void> {
  if (!id) return;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotOwnedError(notFound);
  const rows = await tx
    .select({ id: table.id })
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.organizationId, organizationId)))
    .limit(1);
  if (!rows.length) throw new NotOwnedError(notFound);
}

import type { Tx } from "@/db";
import { auditLogs } from "@/db/schema";
import { redact } from "@/lib/logger";

/** `via` marks changes made on the user's behalf by an automated surface (e.g. the Beacon agent); it is recorded in audit metadata. */
export type Actor = { organizationId: string; userId?: string | null; actorType?: "USER" | "SYSTEM" | "API_KEY"; ipHash?: string; via?: "agent" };

/** Append-only audit trail. Metadata is redacted so credentials can never be logged. */
export async function audit(tx: Tx, actor: Actor, action: string, entityType: string, entityId?: string | null, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({
    organizationId: actor.organizationId,
    actorUserId: actor.userId ?? null,
    actorType: actor.actorType ?? "USER",
    action,
    entityType,
    entityId: entityId ?? null,
    metadata: redact(actor.via ? { ...metadata, via: actor.via } : metadata) as Record<string, unknown>,
    ipHash: actor.ipHash,
  });
}

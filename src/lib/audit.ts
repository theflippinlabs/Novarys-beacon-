import type { Tx } from "@/db";
import { auditLogs } from "@/db/schema";
import { redact } from "@/lib/logger";

export type Actor = { organizationId: string; userId?: string | null; actorType?: "USER" | "SYSTEM" | "API_KEY"; ipHash?: string };

/** Append-only audit trail. Metadata is redacted so credentials can never be logged. */
export async function audit(tx: Tx, actor: Actor, action: string, entityType: string, entityId?: string | null, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({
    organizationId: actor.organizationId,
    actorUserId: actor.userId ?? null,
    actorType: actor.actorType ?? "USER",
    action,
    entityType,
    entityId: entityId ?? null,
    metadata: redact(metadata) as Record<string, unknown>,
    ipHash: actor.ipHash,
  });
}

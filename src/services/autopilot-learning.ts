import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { autopilotLearning } from "@/db/schema";
import type { LearningTally, OutcomeLabel } from "@/core/autopilot/loop";

/** Measured outcome tallies per opportunity type, for the opportunity engine's learning adjustment. */
export async function learningTallies(tx: Tx, organizationId: string): Promise<Record<string, LearningTally>> {
  const rows = await tx.select().from(autopilotLearning).where(eq(autopilotLearning.organizationId, organizationId));
  return Object.fromEntries(rows.map((r) => [r.opportunityType, { improved: r.improved, noChange: r.noChange, declined: r.declined, insufficient: r.insufficient }]));
}

/** LEARN: add one measured outcome to its opportunity type's running tally. */
export async function recordLearning(tx: Tx, organizationId: string, opportunityType: string, label: OutcomeLabel) {
  const inc = (l: OutcomeLabel) => (label === l ? 1 : 0);
  await tx
    .insert(autopilotLearning)
    .values({ organizationId, opportunityType, improved: inc("IMPROVED"), noChange: inc("NO_CHANGE"), declined: inc("DECLINED"), insufficient: inc("INSUFFICIENT_DATA") })
    .onConflictDoUpdate({
      target: [autopilotLearning.organizationId, autopilotLearning.opportunityType],
      set: {
        improved: sql`${autopilotLearning.improved} + ${inc("IMPROVED")}`,
        noChange: sql`${autopilotLearning.noChange} + ${inc("NO_CHANGE")}`,
        declined: sql`${autopilotLearning.declined} + ${inc("DECLINED")}`,
        insufficient: sql`${autopilotLearning.insufficient} + ${inc("INSUFFICIENT_DATA")}`,
        updatedAt: new Date(),
      },
    });
}

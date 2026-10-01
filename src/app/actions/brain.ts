"use server";

import { z } from "zod";
import { brainFindings } from "@/db/schema";
import { act, zId } from "@/lib/actions";
import { assertOwned } from "@/lib/owned";
import { proposeFinding, queueBrainRun } from "@/services/brain";

/** "Run now": queue a Beacon Brain run (refused while one is queued or running). */
export async function runBrainAction(fd: FormData) {
  return act(fd, "job:run", z.object({}), async ({ tx, actor }) => {
    const r = await queueBrainRun(tx, actor, "MANUAL");
    return r.queued ? { ok: "Brain run queued. Results appear here when it finishes." } : { error: "A Brain run is already queued or running." };
  });
}

/** "Propose" on a finding: an autopilot recommendation that waits for a human decision. */
export async function proposeBrainFindingAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await assertOwned(tx, brainFindings, i.id, actor.organizationId, "Finding not found");
    const row = await proposeFinding(tx, actor, i.id);
    return row ? { ok: "Recommendation proposed. It waits for approval in Autopilot." } : { ok: "An open recommendation already exists for this finding." };
  });
}

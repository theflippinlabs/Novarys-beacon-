"use server";

import { z } from "zod";
import { act, zCheckbox, zId } from "@/lib/actions";
import { captureBaseline, launchProduct, setLaunchPlan } from "@/services/launch";

/** Plan the launch (pre-launch mode with an optional date) or turn launch mode off. */
export async function setLaunchPlanAction(fd: FormData) {
  return act(
    fd,
    "product:write",
    z.object({ productId: zId, mode: z.enum(["PRE_LAUNCH", "OFF"]), launchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional() }),
    async ({ tx, actor }, i) => {
      await setLaunchPlan(tx, actor, i.productId, { mode: i.mode, launchDate: i.launchDate || null });
      return { ok: i.mode === "OFF" ? "Launch mode turned off." : "Launch planned. Work through the checklist." };
    },
  );
}

export async function captureBaselineAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const b = await captureBaseline(tx, actor, i.productId);
    return { ok: `Baseline captured: ${b.activeQueries} active queries.` };
  });
}

/** "Launch product": refused while blocking items are open, unless the person explicitly launches anyway. */
export async function launchProductAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, force: zCheckbox }), async ({ tx, actor }, i) => {
    const r = await launchProduct(tx, actor, i.productId, { force: i.force });
    return { ok: r.blockers.length ? `Launched with ${r.blockers.length} open blocking item(s). Monitoring has started.` : "Launched. Monitoring has started." };
  });
}

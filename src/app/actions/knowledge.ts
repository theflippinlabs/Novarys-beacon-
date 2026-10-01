"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "@/db/schema";
import { act, zId } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { answerFaq, suggestFaqs } from "@/services/knowledge";
import { computeAndStoreScore } from "@/services/score";
import { refreshProvenance } from "@/services/provenance";

/** Draft FAQ questions from high-importance queries and active AI prompts (answers are written and verified by humans). */
export async function suggestFaqsAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const s = await suggestFaqs(tx, actor, i.productId);
    return { ok: s.length ? `${s.length} FAQ suggestion(s) added as drafts: answer, source and verify them.` : "No new FAQ suggestions: add high-importance problem or informational queries, or active AI prompts." };
  });
}

export async function answerFaqAction(fd: FormData) {
  return act(fd, "product:write", z.object({ id: zId, question: z.string().trim().min(5).max(300), answer: z.string().trim().min(10).max(3000) }), async ({ tx, actor }, i) => {
    const r = await answerFaq(tx, actor, i.id, { question: i.question, answer: i.answer });
    return { ok: r.changed && r.verification === "NEEDS_REVIEW" ? "Updated and marked for review." : "Answer saved (unverified until reviewed)." };
  });
}

/** Queue a source liveness check now (it also runs weekly). */
export async function checkSourcesAction(fd: FormData) {
  return act(fd, "job:run", z.object({}), async ({ actor }) => {
    await enqueue("sources.check", {}, { organizationId: actor.organizationId, idempotencyKey: `sources:${actor.organizationId}:manual:${Math.floor(Date.now() / 60_000)}` });
    return { ok: "Source check queued. Outdated and conflicting facts are flagged when it completes." };
  });
}

/** Recompute OUTDATED / CONFLICTING flags and confidence from the last source check (no network). */
export async function refreshProvenanceAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const r = await refreshProvenance(tx, actor.organizationId, i.productId);
    await audit(tx, actor, "knowledge.provenance.refresh", "product", i.productId, r);
    return { ok: `Provenance refreshed: ${r.outdated} newly outdated, ${r.conflicting} newly conflicting.` };
  });
}

export async function setStaleAfterDaysAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ days: z.coerce.number().int().min(7).max(3650) }), async ({ tx, actor, ctx }, i) => {
    await tx
      .update(organizations)
      .set({ settings: { ...ctx.org.settings, knowledge: { ...ctx.org.settings.knowledge, staleAfterDays: i.days } } })
      .where(eq(organizations.id, actor.organizationId));
    await audit(tx, actor, "settings.knowledge", "organization", actor.organizationId, { staleAfterDays: i.days });
    return { ok: `Verified facts older than ${i.days} days will be marked outdated.` };
  });
}

/** Recompute and store the Beacon Score (the stored score is what every page shows). */
export async function recomputeScoreAction(fd: FormData) {
  return act(fd, "job:run", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const s = await computeAndStoreScore(tx, actor.organizationId, i.productId);
    await audit(tx, actor, "score.compute", "product", i.productId, { total: s.total });
    return { ok: `Beacon Score recomputed: ${s.total}.` };
  });
}

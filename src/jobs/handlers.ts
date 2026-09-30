import { and, eq } from "drizzle-orm";
import { asSystem, withOrg, type Tx } from "@/db";
import { aiVisibilityPrompts, integrations, organizations } from "@/db/schema";
import { availableProviders, resolveProvider } from "@/ai/registry";
import { generateVersion } from "@/services/content";
import { syncPagePlan } from "@/services/discovery";
import { generateQueryUniverse } from "@/services/queries";
import { executeAudit } from "@/services/seo";
import { syncIntegration } from "@/services/visibility";
import { runPromptTests } from "@/services/ai-visibility";
import { allProductIds, generateProductOpportunities } from "@/services/opportunities";
import { computeAndStoreScore } from "@/services/score";
import { generateGrowthReport } from "@/services/autopilot";
import { analyzeProduct } from "@/services/onboarding";
import { purgeRateLimitBuckets } from "@/lib/security/rate-limit";
import { purgeExpiredSessions } from "@/lib/auth/service";
import { isoDay } from "@/core/util/text";
import { enqueue, NonRetryableError, type Job, type JobType } from "./queue";

type Handler = (job: Job) => Promise<unknown>;

const orgOf = (job: Job) => {
  if (!job.organizationId) throw new NonRetryableError("Job has no organization");
  return job.organizationId;
};
const str = (job: Job, key: string) => {
  const v = job.payload[key];
  if (typeof v !== "string") throw new NonRetryableError(`Missing payload.${key}`);
  return v;
};
const runner = (orgId: string) => <T>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

export const HANDLERS: Record<JobType, Handler> = {
  "seo.audit": async (job) => {
    const orgId = orgOf(job);
    const res = await executeAudit(runner(orgId), str(job, "auditId"));
    const productId = job.payload.productId as string | undefined;
    if (productId) {
      await enqueue("opportunities.generate", { productId }, { organizationId: orgId, idempotencyKey: `opps:${productId}:${job.id}` });
      await enqueue("score.compute", { productId }, { organizationId: orgId, idempotencyKey: `score:${productId}:${job.id}` });
    }
    return res;
  },
  "discovery.plan": async (job) => withOrg(orgOf(job), (tx) => syncPagePlan(tx, job.organizationId!, str(job, "productId"))),
  "queries.generate": async (job) => withOrg(orgOf(job), (tx) => generateQueryUniverse(tx, job.organizationId!, str(job, "productId"))),
  "content.generate": async (job) => {
    const orgId = orgOf(job);
    return withOrg(orgId, async (tx) => {
      const llm = job.payload.useLlm ? await resolveProvider(tx, orgId, "anthropic") : null;
      const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
      const r = await generateVersion(tx, { organizationId: orgId, userId: (job.payload.userId as string) ?? null, actorType: "SYSTEM" }, str(job, "assetId"), llm, org?.branding.displayName ?? org?.name);
      return { status: r.status, version: r.version.version, generatedBy: r.generatedBy };
    });
  },
  "ai_visibility.run": async (job) => {
    const orgId = orgOf(job);
    const providers = await withOrg(orgId, (tx) => availableProviders(tx, orgId));
    if (!providers.length) throw new NonRetryableError("No AI provider configured (Settings → Integrations)");
    const promptIds = job.payload.promptId
      ? [str(job, "promptId")]
      : (await withOrg(orgId, (tx) => tx.select({ id: aiVisibilityPrompts.id }).from(aiVisibilityPrompts).where(and(eq(aiVisibilityPrompts.organizationId, orgId), eq(aiVisibilityPrompts.active, true))))).map((p) => p.id);
    const out = [];
    for (const id of promptIds) out.push(await runPromptTests(runner(orgId), orgId, id, providers));
    return { prompts: promptIds.length, results: out.flat().length };
  },
  "integration.sync": async (job) => syncIntegration(runner(orgOf(job)), str(job, "integrationId"), Number(job.payload.days ?? 28)),
  "opportunities.generate": async (job) => {
    const orgId = orgOf(job);
    return withOrg(orgId, async (tx) => {
      const ids = job.payload.productId ? [str(job, "productId")] : await allProductIds(tx, orgId);
      const res = [];
      for (const id of ids) res.push(await generateProductOpportunities(tx, orgId, id));
      return res;
    });
  },
  "score.compute": async (job) => {
    const orgId = orgOf(job);
    return withOrg(orgId, async (tx) => {
      const ids = job.payload.productId ? [str(job, "productId")] : await allProductIds(tx, orgId);
      const res: Record<string, number> = {};
      for (const id of ids) res[id] = (await computeAndStoreScore(tx, orgId, id)).total;
      return res;
    });
  },
  "autopilot.report": async (job) => withOrg(orgOf(job), async (tx) => ({ reportId: (await generateGrowthReport(tx, job.organizationId!, Number(job.payload.days ?? 7))).id })),
  "product.analyze": async (job) => {
    const orgId = orgOf(job);
    const productId = str(job, "productId");
    const res = await withOrg(orgId, (tx) => analyzeProduct(tx, orgId, productId));
    await enqueue("opportunities.generate", { productId }, { organizationId: orgId, idempotencyKey: `opps:${productId}:${job.id}` });
    await enqueue("score.compute", { productId }, { organizationId: orgId, idempotencyKey: `score:${productId}:${job.id}` });
    return res;
  },
  "metrics.rollup": async () => ({ ok: true }),
  "maintenance.cleanup": async () => {
    await purgeRateLimitBuckets();
    await purgeExpiredSessions();
    return { ok: true };
  },
};

/**
 * Periodic scheduling: enqueue recurring work with period-scoped idempotency
 * keys, so any number of workers/ticks enqueue each unit exactly once.
 */
export async function scheduleRecurring(now = new Date()) {
  const day = isoDay(now);
  const week = `${now.getUTCFullYear()}-w${Math.ceil(((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)}`;
  await enqueue("maintenance.cleanup", {}, { idempotencyKey: `cleanup:${day}` });
  const orgs = await asSystem((tx) => tx.select({ id: organizations.id }).from(organizations));
  for (const o of orgs) {
    const integ = await asSystem((tx) => tx.select().from(integrations).where(and(eq(integrations.organizationId, o.id), eq(integrations.status, "CONNECTED"))));
    for (const i of integ) if (["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "BING_WEBMASTER"].includes(i.provider)) await enqueue("integration.sync", { integrationId: i.id }, { organizationId: o.id, idempotencyKey: `sync:${i.id}:${day}` });
    await enqueue("opportunities.generate", {}, { organizationId: o.id, idempotencyKey: `opps:${o.id}:${day}` });
    await enqueue("score.compute", {}, { organizationId: o.id, idempotencyKey: `score:${o.id}:${day}` });
    await enqueue("autopilot.report", { days: 7 }, { organizationId: o.id, idempotencyKey: `autopilot:${o.id}:${week}` });
    const hasPrompts = await asSystem((tx) => tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.organizationId, o.id), eq(aiVisibilityPrompts.active, true)) }));
    const hasProvider = await asSystem((tx) => availableProviders(tx, o.id));
    if (hasPrompts && hasProvider.length) await enqueue("ai_visibility.run", {}, { organizationId: o.id, idempotencyKey: `aivis:${o.id}:${week}` });
  }
}

import { and, eq, inArray } from "drizzle-orm";
import { asSystem, withOrg, type Tx } from "@/db";
import { aiVisibilityPrompts, integrations, organizations } from "@/db/schema";
import { availableProviders, resolveProvider } from "@/ai/registry";
import { generateQueued } from "@/services/content";
import type { ContentStatus } from "@/core/content/workflow";
import { syncPagePlan } from "@/services/discovery";
import { generateQueryUniverse, importQueriesAfterSync } from "@/services/queries";
import { createScheduledAudit, executeAudit, productsWithVerifiedDomain } from "@/services/seo";
import { backfillSearch, syncIntegration } from "@/services/visibility";
import { isSyncableProvider } from "@/integrations/registry";
import { syncScheduleDecision } from "@/core/integrations/health";
import { runPromptTests } from "@/services/ai-visibility";
import { allProductIds, generateProductOpportunities } from "@/services/opportunities";
import { computeAndStoreScore } from "@/services/score";
import { checkOrganizationSources, type SourceFetcher } from "@/services/provenance";
import { safeFetch } from "@/lib/security/ssrf";
import { dueMeasurements, generateGrowthReport, identifyRecommendations, measureRecommendation } from "@/services/autopilot";
import { analyzeProduct } from "@/services/onboarding";
import { purgeTrackingIpHashes } from "@/services/tracking";
import { purgeRateLimitBuckets } from "@/lib/security/rate-limit";
import { purgeExpiredSessions, purgeLoginThrottle } from "@/lib/auth/service";
import { isoDay } from "@/core/util/text";
import { generateBriefing } from "@/services/briefings";
import { generateWeeklyReport } from "@/services/reports";
import { evaluateNotifications } from "@/services/notifications";
import { deliverEmail, deliverWebhook, PermanentDeliveryError } from "@/services/notification-delivery";
import { emailConfig } from "@/integrations/email";
import { enqueue, NonRetryableError, purgeFinishedJobs, type Job, type JobContext, type JobType } from "./queue";

/** Re-evaluate notifications after work that changes what they watch (syncs, audits, opportunity runs). */
const evaluateAfter = (orgId: string, job: Job) => enqueue("notifications.evaluate", {}, { organizationId: orgId, idempotencyKey: `notif-eval:${job.id}`, runAt: new Date(Date.now() + 60_000) });

type Handler = (job: Job, ctx: JobContext) => Promise<unknown>;

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
/** Like `runner`, but every step also refreshes the job heartbeat (long, multi-step handlers). */
const beatingRunner = (orgId: string, ctx: JobContext) => async <T>(fn: (tx: Tx) => Promise<T>) => {
  await ctx.heartbeat();
  return withOrg(orgId, fn);
};

/** Source liveness: SSRF-safe, small body cap; HEAD then GET fallback lives in checkUrl. */
const sourceFetcher: SourceFetcher = async (url, method) => ({ status: (await safeFetch(url, { method, maxBytes: 64 * 1024, timeoutMs: 10_000, maxRedirects: 5, userAgent: "NovarysBeacon/1.0 (+source-check)" })).status });

export const HANDLERS: Record<JobType, Handler> = {
  "seo.audit": async (job, ctx) => {
    const orgId = orgOf(job);
    // Weekly recurring audits are enqueued without an audit row: create it now (skipped when not allowed).
    let auditId = typeof job.payload.auditId === "string" ? job.payload.auditId : null;
    if (!auditId && job.payload.scheduled === true) {
      const created = await withOrg(orgId, (tx) => createScheduledAudit(tx, orgId, str(job, "productId")));
      if ("skipped" in created) return created;
      auditId = created.auditId;
    }
    const res = await executeAudit(beatingRunner(orgId, ctx), auditId ?? str(job, "auditId"), undefined, { onProgress: () => void ctx.heartbeat().catch(() => undefined) }).finally(() => evaluateAfter(orgId, job).catch(() => null));
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
    // Read in one transaction, call the LLM with no transaction open, persist in a second one.
    const orgId = orgOf(job);
    const p = job.payload;
    const base = typeof p.baseVersion === "number" && typeof p.baseStatus === "string" ? { version: p.baseVersion, status: p.baseStatus as ContentStatus } : null;
    const r = await generateQueued(runner(orgId), { organizationId: orgId, userId: (p.userId as string) ?? null, actorType: "SYSTEM" }, str(job, "assetId"), {
      resolveLlm: p.useLlm ? (tx) => resolveProvider(tx, orgId, "anthropic") : undefined,
      base,
    });
    return r.aborted ? { aborted: true, note: r.note } : { status: r.status, version: r.version.version, generatedBy: r.generatedBy };
  },
  "ai_visibility.run": async (job, ctx) => {
    const orgId = orgOf(job);
    const providers = await withOrg(orgId, (tx) => availableProviders(tx, orgId));
    if (!providers.length) throw new NonRetryableError("No AI provider configured (Settings → Integrations)");
    const promptIds = job.payload.promptId
      ? [str(job, "promptId")]
      : (await withOrg(orgId, (tx) => tx.select({ id: aiVisibilityPrompts.id }).from(aiVisibilityPrompts).where(and(eq(aiVisibilityPrompts.organizationId, orgId), eq(aiVisibilityPrompts.active, true))))).map((p) => p.id);
    const out = [];
    for (const id of promptIds) out.push(await runPromptTests(beatingRunner(orgId, ctx), orgId, id, providers));
    return { prompts: promptIds.length, results: out.flat().length };
  },
  "integration.sync": async (job) => {
    const res = await syncIntegration(runner(orgOf(job)), str(job, "integrationId"), job.payload.days ? Number(job.payload.days) : undefined);
    // Real demand: measured search queries become CANDIDATE queries (never blocks or fails the sync).
    await importQueriesAfterSync(runner(orgOf(job)), orgOf(job), str(job, "integrationId")).catch(() => null);
    await evaluateAfter(orgOf(job), job).catch(() => null);
    // Autopilot IDENTIFY after a search sync: fresh demand refreshes opportunities and proposals (deduped).
    const synced = await withOrg(orgOf(job), (tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, str(job, "integrationId")), columns: { provider: true, productId: true } }));
    if (synced && (synced.provider === "GOOGLE_SEARCH_CONSOLE" || synced.provider === "BING_WEBMASTER"))
      await enqueue("autopilot.identify", synced.productId ? { productId: synced.productId } : {}, { organizationId: orgOf(job), idempotencyKey: `identify:${str(job, "integrationId")}:${isoDay(new Date())}` }).catch(() => null);
    return res;
  },
  "search.backfill": async (job, ctx) =>
    backfillSearch(beatingRunner(orgOf(job), ctx), str(job, "integrationId"), { since: typeof job.payload.since === "string" ? job.payload.since : null, runId: typeof job.payload.runId === "string" ? job.payload.runId : undefined }),
  "opportunities.generate": async (job) => {
    const orgId = orgOf(job);
    const out = await withOrg(orgId, async (tx) => {
      const ids = job.payload.productId ? [str(job, "productId")] : await allProductIds(tx, orgId);
      const res = [];
      for (const id of ids) res.push(await generateProductOpportunities(tx, orgId, id));
      return res;
    });
    await evaluateAfter(orgId, job).catch(() => null);
    return out;
  },
  "sources.check": async (job) => checkOrganizationSources(runner(orgOf(job)), orgOf(job), sourceFetcher),
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
  "autopilot.identify": async (job) => {
    const orgId = orgOf(job);
    return withOrg(orgId, async (tx) => {
      const productId = typeof job.payload.productId === "string" ? job.payload.productId : null;
      for (const id of productId ? [productId] : await allProductIds(tx, orgId)) await generateProductOpportunities(tx, orgId, id);
      return identifyRecommendations(tx, orgId, { productId });
    });
  },
  "recommendation.measure": async (job) => withOrg(orgOf(job), (tx) => measureRecommendation(tx, job.organizationId!, str(job, "recommendationId"))),
  "product.analyze": async (job) => {
    const orgId = orgOf(job);
    const productId = str(job, "productId");
    const res = await withOrg(orgId, (tx) => analyzeProduct(tx, orgId, productId, { completeOnboarding: job.payload.completeOnboarding !== false }));
    await enqueue("opportunities.generate", { productId }, { organizationId: orgId, idempotencyKey: `opps:${productId}:${job.id}` });
    await enqueue("score.compute", { productId }, { organizationId: orgId, idempotencyKey: `score:${productId}:${job.id}` });
    return res;
  },
  "briefing.generate": async (job) => {
    const orgId = orgOf(job);
    return withOrg(orgId, async (tx) => ({ briefingId: (await generateBriefing(tx, orgId)).id }));
  },
  "reports.generate": async (job) => {
    const orgId = orgOf(job);
    return withOrg(orgId, async (tx) => ({ reportId: (await generateWeeklyReport(tx, orgId)).id }));
  },
  "notifications.evaluate": async (job) => {
    const orgId = orgOf(job);
    const emailConfigured = emailConfig().configured;
    const res = await evaluateNotifications(runner(orgId), orgId, { emailConfigured });
    // Deliveries start after the digests are committed, a little later so same-run signals are merged.
    const runAt = new Date(Date.now() + 2 * 60_000);
    for (const d of res.deliveries)
      await enqueue("notifications.deliver", d.channel === "WEBHOOK" ? { channel: d.channel, notificationId: d.notificationId, webhookId: d.webhookId } : { channel: d.channel, notificationId: d.notificationId }, {
        organizationId: orgId,
        idempotencyKey: `notif-deliver:${d.channel}:${d.notificationId}:${d.channel === "WEBHOOK" ? d.webhookId : d.userId}`,
        runAt,
        maxAttempts: 6,
      });
    return { signals: res.signals, fresh: res.fresh, digests: res.digests, deliveries: res.deliveries.length };
  },
  "notifications.deliver": async (job) => {
    const orgId = orgOf(job);
    try {
      if (job.payload.channel === "WEBHOOK") return await deliverWebhook(orgId, str(job, "webhookId"), job.payload.test === true ? null : str(job, "notificationId"));
      if (job.payload.channel === "EMAIL") return await deliverEmail(orgId, str(job, "notificationId"));
    } catch (e) {
      if (e instanceof PermanentDeliveryError) throw new NonRetryableError(e.message);
      throw e;
    }
    throw new NonRetryableError("Unknown notification channel");
  },
  "maintenance.cleanup": async () => {
    await purgeRateLimitBuckets();
    await purgeExpiredSessions();
    await purgeLoginThrottle();
    // Retention: finished jobs are deleted after 30 days. Audit logs are kept
    // (compliance record of every mutation); they are never purged here.
    const jobsPurged = await purgeFinishedJobs(30);
    // Privacy: keyed IP hashes on tracking touches are cleared after 90 days.
    const ipHashesCleared = await purgeTrackingIpHashes();
    return { ok: true, jobsPurged, ipHashesCleared };
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
  // Autopilot MEASURE sweep: any executed recommendation past its measure_after date and not measured yet.
  for (const d of await asSystem((tx) => dueMeasurements(tx, day)))
    await enqueue("recommendation.measure", { recommendationId: d.id }, { organizationId: d.organizationId, idempotencyKey: `measure-sweep:${d.id}:${day}` });
  const orgs = await asSystem((tx) => tx.select({ id: organizations.id }).from(organizations));
  for (const o of orgs) {
    // CONNECTED daily; ERROR again after a back-off; DISABLED and EXPIRED wait for a human (see core/integrations/health).
    const integ = await asSystem((tx) => tx.select().from(integrations).where(and(eq(integrations.organizationId, o.id), inArray(integrations.status, ["CONNECTED", "ERROR"]))));
    for (const i of integ) {
      if (!isSyncableProvider(i.provider)) continue;
      const decision = syncScheduleDecision(i, now);
      if (decision.enqueue) await enqueue("integration.sync", { integrationId: i.id }, { organizationId: o.id, idempotencyKey: decision.key! });
    }
    await enqueue("opportunities.generate", {}, { organizationId: o.id, idempotencyKey: `opps:${o.id}:${day}` });
    await enqueue("score.compute", {}, { organizationId: o.id, idempotencyKey: `score:${o.id}:${day}` });
    await enqueue("autopilot.report", { days: 7 }, { organizationId: o.id, idempotencyKey: `autopilot:${o.id}:${week}` });
    await enqueue("briefing.generate", {}, { organizationId: o.id, idempotencyKey: `briefing:${o.id}:${day}` });
    await enqueue("reports.generate", {}, { organizationId: o.id, idempotencyKey: `report-weekly:${o.id}:${week}` });
    await enqueue("notifications.evaluate", {}, { organizationId: o.id, idempotencyKey: `notif-eval:${o.id}:${day}` });
    await enqueue("sources.check", {}, { organizationId: o.id, idempotencyKey: `sources:${o.id}:${week}` });
    // Weekly technical audit of every product whose own domain is verified.
    for (const productId of await asSystem((tx) => productsWithVerifiedDomain(tx, o.id)))
      await enqueue("seo.audit", { productId, scheduled: true }, { organizationId: o.id, idempotencyKey: `audit-weekly:${productId}:${week}` });
    const hasPrompts = await asSystem((tx) => tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.organizationId, o.id), eq(aiVisibilityPrompts.active, true)) }));
    const hasProvider = await asSystem((tx) => availableProviders(tx, o.id));
    if (hasPrompts && hasProvider.length) await enqueue("ai_visibility.run", {}, { organizationId: o.id, idempotencyKey: `aivis:${o.id}:${week}` });
  }
}

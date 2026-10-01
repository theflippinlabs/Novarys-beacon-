import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiVisibilityPrompts, experiments, growthReports, recommendations } from "@/db/schema";
import { buildFunnel, type FunnelStep } from "@/core/conversions/funnel";
import type { GrowthAnalysis } from "@/core/autopilot/analyst";
import { availableProviders } from "@/ai/registry";
import { enqueue } from "@/jobs/queue";
import { audit } from "@/lib/audit";
import { aiVisibilityTrend, promptSummaries } from "@/services/ai-visibility";
import { conversionsByChannel, funnelCounts, hasConversionEvents, kpis, mrrByDimension, revenueByDimension } from "@/services/metrics";
import { defineTool } from "../types";
import { agentActor, capped, daysInput, idRef, iso, kpi, optionalProductRef, requirePermission, resolveOptionalProduct, trim } from "./util";

const SAMPLED = "AI-visibility results are sampled observations from official APIs; they do not represent every user's AI answer and never guarantee placement.";

export const getAiVisibility = defineTool({
  name: "get_ai_visibility",
  label: "Reading AI visibility",
  description: `Read AI-visibility monitoring: tracked prompts with tests run in the last 90 days, how often the product/organisation was mentioned or its domain cited, competitors mentioned, the weekly trend, and which AI providers are configured. ${SAMPLED}`,
  permission: "read",
  kind: "read",
  input: z.object({ product: optionalProductRef() }),
  run: async ({ tx, ctx }, i) => {
    const product = await resolveOptionalProduct(tx, ctx.org.id, i.product);
    const summaries = await promptSummaries(tx, ctx.org.id, product?.id);
    const trend = await aiVisibilityTrend(tx, ctx.org.id, 12, product?.id);
    const providers = await availableProviders(tx, ctx.org.id);
    return {
      providersConfigured: providers.length ? providers.map((p) => `${p.id} (${p.model})`) : "not connected",
      prompts: capped(
        summaries.map((s) => ({ id: s.prompt.id, prompt: trim(s.prompt.prompt, 200), active: s.prompt.active, testsRun90d: s.testsRun, mentioned: s.mentions, ownDomainCited: s.cited, competitorsMentioned: s.competitors.slice(0, 10), lastRunAt: iso(s.last?.ranAt) })),
      ),
      weeklyTrend: trend,
      note: SAMPLED,
      link: "/ai-visibility",
    };
  },
});

export const queueAiVisibilityTests = defineTool({
  name: "queue_ai_visibility_tests",
  label: "Queuing AI visibility tests",
  description: `Queue sampled AI-visibility tests for one tracked prompt or all active prompts, run in the background through the configured AI providers. Fails if no provider is configured (an admin connects one in Settings → Integrations). ${SAMPLED}`,
  permission: "job:run",
  kind: "write",
  input: z.object({ promptId: idRef("Only this prompt (from get_ai_visibility). Omit for all active prompts.").optional() }),
  run: async (c, i) => {
    requirePermission(c, "job:run");
    const org = c.ctx.org.id;
    const providers = await availableProviders(c.tx, org);
    if (!providers.length) throw new Error("No AI provider is connected. An admin can add one in Settings → Integrations.");
    if (i.promptId) {
      const p = await c.tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.id, i.promptId), eq(aiVisibilityPrompts.organizationId, org)) });
      if (!p) throw new Error("Prompt not found");
    } else {
      const any = await c.tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.organizationId, org), eq(aiVisibilityPrompts.active, true)) });
      if (!any) throw new Error("There are no active AI-visibility prompts to test. Add prompts on the AI visibility page first.");
    }
    const job = await enqueue("ai_visibility.run", i.promptId ? { promptId: i.promptId } : {}, { organizationId: org, idempotencyKey: `aivis:manual:${i.promptId ?? "all"}:${Math.floor(Date.now() / 60_000)}` });
    await audit(c.tx, agentActor(c), "ai_visibility.queue", "ai_visibility_prompt", i.promptId ?? null, { jobId: job.id });
    return { queued: true, scope: i.promptId ? "one prompt" : "all active prompts", providers: providers.map((p) => p.id), note: SAMPLED, link: "/ai-visibility" };
  },
});

export const getConversionsSummary = defineTool({
  name: "get_conversions_summary",
  label: "Reading conversions",
  description: "Read the conversion funnel (page view → CTA click → signup → trial → activation → checkout → subscription, distinct visitors per step and step rates) and the breakdown by acquisition channel for a period, from Beacon's first-party events. If no events were ever received, returns \"not connected\"; never estimate.",
  permission: "read",
  kind: "read",
  input: z.object({ days: daysInput, product: optionalProductRef() }),
  run: async ({ tx, ctx }, i) => {
    const days = i.days ?? 28;
    const product = await resolveOptionalProduct(tx, ctx.org.id, i.product);
    if (!(await hasConversionEvents(tx, ctx.org.id))) return { status: "not connected", detail: "No first-party events received yet. Install the Beacon tracker from a product's Tracking tab.", link: product ? `/products/${product.slug}/tracking` : "/conversions" };
    const counts = await funnelCounts(tx, ctx.org.id, days, product?.id ?? null, null);
    const byChannel = await conversionsByChannel(tx, ctx.org.id, days, product?.id ?? null);
    return {
      periodDays: days,
      product: product?.slug ?? "all",
      funnel: buildFunnel(counts as Partial<Record<FunnelStep, number>>).map((r) => ({ step: r.step, visitors: r.visitors, rateFromPrevious: r.conversionFromPrev, rateFromStart: r.conversionFromStart })),
      byChannel: capped(byChannel),
      note: "Rates are null when there is no denominator.",
      link: product ? `/conversions?product=${product.slug}&days=${days}` : `/conversions?days=${days}`,
    };
  },
});

export const getRevenueSummary = defineTool({
  name: "get_revenue_summary",
  label: "Reading revenue",
  description: "Read revenue for a period vs the previous period: new subscriptions, revenue, new MRR via Beacon channels, current MRR/ARR, and revenue/MRR by acquisition channel. Amounts are in minor units (cents) and grouped per currency (never summed across currencies). If no revenue source is connected, values are \"not connected\".",
  permission: "read",
  kind: "read",
  input: z.object({ days: daysInput }),
  run: async ({ tx, ctx }, i) => {
    const days = i.days ?? 28;
    const k = await kpis(tx, ctx.org.id, { days });
    const connected = k.revenue.revenue.now !== null;
    const byChannel = connected ? await revenueByDimension(tx, ctx.org.id, "channel", days) : [];
    const mrrByChannel = connected ? await mrrByDimension(tx, ctx.org.id, "channel") : [];
    return {
      periodDays: days,
      currency: connected ? k.currency : null,
      newSubscriptions: kpi(k.revenue.newSubscriptions),
      revenue: kpi(k.revenue.revenue, "money_minor_units"),
      newMrrViaBeaconChannels: kpi(k.revenue.beaconNewMrr, "money_minor_units"),
      mrr: kpi(k.revenue.mrr, "money_minor_units"),
      mrrAttributableToBeacon: kpi(k.revenue.beaconMrr, "money_minor_units"),
      arr: kpi(k.revenue.arr, "money_minor_units"),
      revenueByChannel: connected ? capped(byChannel) : "not connected",
      mrrByChannel: connected ? capped(mrrByChannel) : "not connected",
      link: `/revenue?days=${days}`,
    };
  },
});

export const getAutopilot = defineTool({
  name: "get_autopilot",
  label: "Reading the growth autopilot",
  description:
    "Read the latest growth-analyst report (what happened with sources, possible explanations labelled CORRELATION or INSUFFICIENT_DATA (never causation), content to create, technical issues, signals to monitor, data-coverage gaps), the recommendations awaiting a human decision, and experiments. Recommendations are approved or rejected by an authorised person in the app.",
  permission: "read",
  kind: "read",
  input: z.object({}),
  run: async ({ tx, ctx }) => {
    const org = ctx.org.id;
    const report = await tx.query.growthReports.findFirst({ where: eq(growthReports.organizationId, org), orderBy: desc(growthReports.createdAt) });
    const recs = await tx.select().from(recommendations).where(and(eq(recommendations.organizationId, org), eq(recommendations.status, "PROPOSED"))).orderBy(desc(recommendations.createdAt)).limit(26);
    const exps = await tx.select().from(experiments).where(eq(experiments.organizationId, org)).orderBy(desc(experiments.updatedAt)).limit(26);
    const s = report?.sections as Partial<GrowthAnalysis> | undefined;
    return {
      latestReport: report
        ? {
            id: report.id,
            period: { start: report.periodStart, end: report.periodEnd },
            generatedAt: iso(report.createdAt),
            whatHappened: (s?.whatHappened ?? []).slice(0, 12),
            whyItMayHaveHappened: (s?.whyItMayHaveHappened ?? []).slice(0, 8),
            contentToCreate: (s?.contentToCreate ?? []).slice(0, 10),
            technicalIssues: (s?.technicalIssues ?? []).slice(0, 10),
            signalsToMonitor: (s?.signalsToMonitor ?? []).slice(0, 10),
            dataCoverage: s?.dataCoverage ?? null,
            disclaimer: s?.disclaimer ?? null,
          }
        : "no report yet",
      recommendationsAwaitingDecision: capped(recs.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: trim(r.body, 300), requiresApproval: r.requiresApproval, createdAt: iso(r.createdAt) }))),
      experiments: capped(exps.map((e) => ({ id: e.id, name: e.name, status: e.status, hypothesis: trim(e.hypothesis, 200), primaryMetric: e.primaryMetric, startsOn: e.startsOn, endsOn: e.endsOn, result: trim(e.result, 200) }))),
      link: "/autopilot",
    };
  },
});

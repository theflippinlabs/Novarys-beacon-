import { z } from "zod";
import { prioritizeAttention } from "@/core/command/attention";
import { attentionItems, commandCenterData } from "@/services/overview";
import { defineTool } from "../types";
import { daysInput, iso, kpi } from "./util";

export const getWorkspaceOverview = defineTool({
  name: "get_workspace_overview",
  label: "Reading the overview",
  description:
    "Read the command center for the whole workspace: the ranked priority queue (what needs attention today), the measured KPIs (discovery, acquisition, revenue, ecosystem, content) for the period vs the previous period, and every product with its latest Beacon Score. Use it first when the user asks how things are going or what to do next. KPIs whose data source is not connected are returned as { status: \"not connected\" }, connected sources without data yet as { status: \"no data yet\" }; report them as such, never estimate them. Money values are in minor units (cents) of their `currency`; several currencies are listed in `byCurrency` and never added together. Beacon tracker AI referrals and GA4 AI referral sessions are separate sources: never add them.",
  permission: "read",
  kind: "read",
  input: z.object({ days: daysInput }),
  run: async ({ tx, ctx, t }, input) => {
    const days = input.days ?? 28;
    const data = await commandCenterData(tx, ctx.org.id, days);
    const k = data.k;
    const attention = prioritizeAttention(attentionItems(data, t)).map((a) => ({ title: a.title, detail: a.detail || null, count: a.count, priority: a.priority, link: a.href }));
    return {
      organisation: ctx.org.branding.displayName ?? ctx.org.name,
      periodDays: days,
      link: "/",
      priorityQueue: attention,
      products: data.products.map((p) => {
        const s = data.scores.get(p.id);
        return { name: p.name, slug: p.slug, status: p.status, beaconScore: s ? { total: Math.round(s.total), computedAt: iso(s.computedAt) } : "not computed yet", link: `/products/${p.slug}` };
      }),
      kpis: {
        currencies: k.currencies,
        discovery: {
          organicImpressions: kpi(k.discovery.organicImpressions),
          organicClicks: kpi(k.discovery.organicClicks),
          indexablePages: kpi(k.discovery.indexedPages),
          coveredQueries: kpi(k.discovery.coveredQueries),
          brandedImpressions: kpi(k.discovery.brandedImpressions),
          aiReferralsBeaconTracker: kpi(k.discovery.aiReferrals),
          aiReferralSessionsGa4: kpi(k.discovery.aiReferralSessionsGa4),
          observedAiMentions: kpi(k.discovery.aiMentions),
        },
        acquisition: { visitors: kpi(k.acquisition.visitors), signups: kpi(k.acquisition.signups), trials: kpi(k.acquisition.trials), activations: kpi(k.acquisition.activations) },
        revenue: {
          newSubscriptions: kpi(k.revenue.newSubscriptions),
          revenue: kpi(k.revenue.revenue, "money_minor_units"),
          newMrrViaBeaconChannels: kpi(k.revenue.beaconNewMrr, "money_minor_units"),
          mrr: kpi(k.revenue.mrr, "money_minor_units"),
          mrrAttributableToBeacon: kpi(k.revenue.beaconMrr, "money_minor_units"),
          arr: kpi(k.revenue.arr, "money_minor_units"),
          conversionRate: kpi(k.revenue.conversionRate, "ratio"),
        },
        ecosystem: {
          crossSellConversion: kpi(k.ecosystem.crossSellRate, "ratio"),
          multiProductUsers: kpi(k.ecosystem.multiProductUsers),
          referralConversions: kpi(k.ecosystem.referralConversions),
          affiliateRevenue: kpi(k.ecosystem.affiliateRevenue, "money_minor_units"),
        },
        content: { published: kpi(k.content.published), publishedInPeriod: kpi(k.content.publishedInPeriod) },
      },
      note: "Everything is measured. AI mentions are sampled observations, not totals.",
    };
  },
});

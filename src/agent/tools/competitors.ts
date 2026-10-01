import { z } from "zod";
import { listWatches, recentChanges } from "@/services/competitor-watch";
import { defineTool } from "../types";
import { capped, iso, limitInput, LIST_CAP, trim } from "./util";

const HUMAN_REVIEW = "Detected changes are quoted from the competitor's public page and need human review; they never update facts or comparison facts automatically, and this tool cannot change them.";

export const listCompetitorChanges = defineTool({
  name: "list_competitor_changes",
  label: "Reading competitor page changes",
  description: `Read the competitor pages Beacon watches (weekly, robots.txt respected, one page each): status of the last check, last change, and the changes detected in a recent window with a factual diff summary (lines added/removed, price-like tokens that appeared or disappeared, quoted from the page). ${HUMAN_REVIEW}`,
  permission: "read",
  kind: "read",
  input: z.object({
    days: z.number().int().min(1).max(365).optional().describe("Window for detected changes in days (default 30)."),
    limit: limitInput,
  }),
  run: async ({ tx, ctx }, i) => {
    const watches = await listWatches(tx, ctx.org.id, { perWatch: 0 });
    if (!watches.length) return { status: "no watched pages", detail: "No competitor page is watched yet. A member adds pages under AI visibility, Watched competitor pages.", link: "/ai-visibility#watched-pages" };
    const changes = await recentChanges(tx, ctx.org.id, { days: i.days ?? 30, limit: i.limit ?? LIST_CAP });
    return {
      watched: capped(
        watches.map((w) => ({ id: w.id, competitor: w.competitorName, url: w.url, kind: w.kind, active: w.active, status: w.status, httpStatus: w.httpStatus, lastCheckedAt: iso(w.lastFetchedAt), lastChangedAt: iso(w.lastChangedAt), error: trim(w.error, 200) })),
      ),
      changes: changes.map((c) => ({
        competitor: c.competitorName,
        url: c.url,
        kind: c.kind,
        detectedAt: iso(c.fetchedAt),
        linesAdded: c.diff?.linesAdded ?? null,
        linesRemoved: c.diff?.linesRemoved ?? null,
        pricesAppeared: c.diff?.pricesAppeared ?? [],
        pricesDisappeared: c.diff?.pricesDisappeared ?? [],
        addedSample: (c.diff?.added ?? []).slice(0, 3),
        removedSample: (c.diff?.removed ?? []).slice(0, 3),
      })),
      windowDays: i.days ?? 30,
      note: HUMAN_REVIEW,
      link: "/ai-visibility#watched-pages",
    };
  },
});

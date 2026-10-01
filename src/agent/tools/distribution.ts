import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { distributionTargets, products } from "@/db/schema";
import { addDistributionTarget, setDistributionStatus } from "@/services/distribution";
import { defineTool } from "../types";
import { agentActor, capped, idRef, iso, limitInput, LIST_CAP, optionalProductRef, requirePermission, resolveOptionalProduct, trim } from "./util";

const KINDS = z.enum(["DIRECTORY", "LAUNCH_PLATFORM", "COMMUNITY", "SOCIAL_CHANNEL", "NEWSLETTER", "PARTNER", "AFFILIATE", "INFLUENCER", "AGENCY", "MEDIA", "BACKLINK"]);
const NEVER_SUBMITS = "Beacon never submits to third-party platforms: SUBMITTED/PUBLISHED require a human approver and are recorded by people in the app.";

export const listDistributionTargets = defineTool({
  name: "list_distribution_targets",
  label: "Reading distribution targets",
  description: `List distribution targets (directories, launch platforms, communities, newsletters, partners, media…) with their stage DISCOVERED → QUALIFIED → PREPARED → SUBMITTED → PUBLISHED → PERFORMING (+ FOLLOW_UP, REJECTED), relevance 1 to 5 and whether an external submission was approved. ${NEVER_SUBMITS}`,
  permission: "read",
  kind: "read",
  input: z.object({
    product: optionalProductRef(),
    kind: KINDS.optional().describe("Only this kind of venue."),
    status: z.enum(["DISCOVERED", "QUALIFIED", "PREPARED", "SUBMITTED", "PUBLISHED", "REJECTED", "FOLLOW_UP", "PERFORMING"]).optional().describe("Only this stage."),
    limit: limitInput,
  }),
  run: async ({ tx, ctx }, i) => {
    const product = await resolveOptionalProduct(tx, ctx.org.id, i.product);
    const limit = i.limit ?? LIST_CAP;
    const rows = await tx
      .select({ t: distributionTargets, productSlug: products.slug })
      .from(distributionTargets)
      .leftJoin(products, eq(products.id, distributionTargets.productId))
      .where(and(eq(distributionTargets.organizationId, ctx.org.id), product ? eq(distributionTargets.productId, product.id) : undefined, i.kind ? eq(distributionTargets.kind, i.kind) : undefined, i.status ? eq(distributionTargets.status, i.status) : undefined))
      .orderBy(desc(distributionTargets.updatedAt))
      .limit(limit + 1);
    return {
      ...capped(
        rows.map(({ t, productSlug }) => ({ id: t.id, name: t.name, kind: t.kind, url: t.url, status: t.status, relevance: t.relevance, product: productSlug, submissionApproved: Boolean(t.submissionApprovedAt), publishedUrl: t.publishedUrl, followUpOn: t.followUpOn, notes: trim(t.notes, 200), updatedAt: iso(t.updatedAt) })),
        limit,
      ),
      link: "/distribution",
    };
  },
});

export const addDistributionTargetTool = defineTool({
  name: "add_distribution_target",
  label: "Adding a distribution target",
  description: `Add a venue where the product could be listed or mentioned (stage DISCOVERED). Only add real venues; do not claim acceptance or traffic. ${NEVER_SUBMITS}`,
  permission: "distribution:write",
  kind: "write",
  input: z.object({
    name: z.string().trim().min(2).max(120).describe("Venue name."),
    kind: KINDS.describe("Kind of venue."),
    url: z.string().trim().max(2000).regex(/^https:\/\/\S+$/i, "must be an https:// URL").optional().describe("Venue URL (https)."),
    product: optionalProductRef("The product to distribute"),
    relevance: z.number().int().min(1).max(5).optional().describe("Relevance 1 to 5 for this product."),
    notes: z.string().trim().max(1000).optional().describe("Why it fits, requirements, audience."),
  }),
  run: async (c, i) => {
    requirePermission(c, "distribution:write");
    const product = await resolveOptionalProduct(c.tx, c.ctx.org.id, i.product);
    const row = await addDistributionTarget(c.tx, agentActor(c), { name: i.name, kind: i.kind, url: i.url ?? null, productId: product?.id ?? null, relevance: i.relevance ?? null, notes: i.notes ?? null });
    return { added: { id: row.id, name: row.name, kind: row.kind, status: row.status }, link: "/distribution" };
  },
});

export const setDistributionTargetStatus = defineTool({
  name: "set_distribution_target_status",
  label: "Updating a distribution target",
  description: `Move a distribution target between the internal preparation stages: DISCOVERED, QUALIFIED (relevant, worth pursuing), PREPARED (listing material ready for a human to review and submit), FOLLOW_UP or REJECTED (not a fit). ${NEVER_SUBMITS}`,
  permission: "distribution:write",
  kind: "write",
  input: z.object({
    id: idRef("Distribution target id."),
    status: z.enum(["DISCOVERED", "QUALIFIED", "PREPARED", "FOLLOW_UP", "REJECTED"]).describe("New stage (external submission stages are human-only)."),
    followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Follow-up date YYYY-MM-DD (with FOLLOW_UP)."),
  }),
  run: async (c, i) => {
    requirePermission(c, "distribution:write");
    const t = await setDistributionStatus(c.tx, agentActor(c), i.id, i.status, { followUpOn: i.followUpOn ?? null });
    return { id: t.id, name: t.name, status: t.status, note: i.status === "PREPARED" ? "Ready for a human to approve and submit in the app." : undefined, link: "/distribution" };
  },
});

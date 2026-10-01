import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { agentUsage, type organizations } from "@/db/schema";
import { env } from "@/lib/env";
import { budgetStatus, resolveCap, usageMonth, type BudgetStatus } from "@/agent/budget";

type OrgSettings = (typeof organizations.$inferSelect)["settings"];

/** This month's agent usage against the organisation's cap. */
export async function agentBudget(tx: Tx, organizationId: string, settings: OrgSettings, now: Date = new Date()): Promise<BudgetStatus> {
  const month = usageMonth(now);
  const [row] = await tx
    .select({ inputTokens: agentUsage.inputTokens, outputTokens: agentUsage.outputTokens, requests: agentUsage.requests })
    .from(agentUsage)
    .where(and(eq(agentUsage.organizationId, organizationId), eq(agentUsage.month, month)));
  return budgetStatus(row ?? null, resolveCap(settings.agent?.monthlyTokenCap, env().BEACON_AGENT_MONTHLY_TOKEN_CAP), month);
}

/** Adds one model request to this month's counters (atomic upsert, safe under concurrency). */
export async function recordAgentUsage(tx: Tx, organizationId: string, tokens: { input: number; output: number }, now: Date = new Date()) {
  await tx
    .insert(agentUsage)
    .values({ organizationId, month: usageMonth(now), inputTokens: tokens.input, outputTokens: tokens.output, requests: 1 })
    .onConflictDoUpdate({
      target: [agentUsage.organizationId, agentUsage.month],
      set: {
        inputTokens: sql`${agentUsage.inputTokens} + ${tokens.input}`,
        outputTokens: sql`${agentUsage.outputTokens} + ${tokens.output}`,
        requests: sql`${agentUsage.requests} + 1`,
        updatedAt: new Date(),
      },
    });
}

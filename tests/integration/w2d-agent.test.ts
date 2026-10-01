import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { asSystem, closeDb, withOrg } from "@/db";
import { agentConversations, agentMessages, agentUsage, organizations, products } from "@/db/schema";
import { BUDGET_MESSAGE, findPendingConfirmation, runAgentTurn, runTool, ToolTimeoutError, type AgentEvent } from "@/agent/loop";
import { appendMessage, appendSummary, createConversation, loadAgentHistory, loadConversation } from "@/agent/store";
import { AGENT_TOOLS } from "@/agent/tools";
import { defineTool } from "@/agent/types";
import { frameToolResult } from "@/agent/framing";
import { isNeedsConfirmation } from "@/agent/confirm";
import { usageMonth } from "@/agent/budget";
import type { AuthContext } from "@/lib/auth/service";
import type { Role } from "@/lib/auth/rbac";
import { saveIntegration } from "@/services/visibility";
import { agentBudget, recordAgentUsage } from "@/services/agent-usage";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

type Org = Awaited<ReturnType<typeof newOrg>>;
let A: Org;
let B: Org;
let slugA: string;
let productA: string;

async function authFor(o: Org, role: Role = "OWNER"): Promise<AuthContext> {
  const org = (await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.id, o.org.id) })))!;
  return { user: { id: o.user.id, email: o.email, name: "Owner" }, org: { id: org.id, slug: org.slug, name: org.name, settings: org.settings, branding: org.branding }, role, sessionTokenHash: "test" };
}
const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
const actorOf = (o: Org) => ({ ...o.actor, via: "agent" as const });

beforeAll(async () => {
  A = await newOrg("w2d-agent-a");
  B = await newOrg("w2d-agent-b");
  const p = await seedCompleteProduct(A.org.id, { name: `Agent Hard ${uid()}`, domain: "agent-hard.example" });
  slugA = p.product.slug;
  productA = p.product.id;
});
afterAll(closeDb);

describe("confirmation step for impactful writes", () => {
  it("changing the domain returns needs_confirmation and changes nothing until the id is approved", async () => {
    const ctx = await authFor(A);
    const conv = await createConversation(ctx, "confirm");
    const input = { product: slugA, domain: "new-domain.example" };
    const first = await runTool(tool("update_product"), "update_product", input, ctx, actorOf(A), "en", { conversationId: conv.id });
    expect(isNeedsConfirmation(first)).toBe(true);
    const id = (first as { confirmation_id: string }).confirmation_id;
    expect((first as { summary: string }).summary).toContain("new-domain.example");
    expect((await withOrg(A.org.id, (tx) => tx.query.products.findFirst({ where: eq(products.id, productA) })))!.domain).toBe("agent-hard.example");

    // An approval for another conversation or another input does not apply.
    const other = await createConversation(ctx, "other");
    expect(isNeedsConfirmation(await runTool(tool("update_product"), "update_product", input, ctx, actorOf(A), "en", { conversationId: other.id, approved: new Set([id]) }))).toBe(true);
    expect(isNeedsConfirmation(await runTool(tool("update_product"), "update_product", { ...input, domain: "evil.example" }, ctx, actorOf(A), "en", { conversationId: conv.id, approved: new Set([id]) }))).toBe(true);

    const done = (await runTool(tool("update_product"), "update_product", input, ctx, actorOf(A), "en", { conversationId: conv.id, approved: new Set([id]) })) as { updated: string[] };
    expect(done.updated).toContain("domain");
    expect((await withOrg(A.org.id, (tx) => tx.query.products.findFirst({ where: eq(products.id, productA) })))!.domain).toBe("new-domain.example");
    // Non-impactful fields need no confirmation.
    const plain = await runTool(tool("update_product"), "update_product", { product: slugA, category: "Live moderation tools" }, ctx, actorOf(A), "en", { conversationId: conv.id });
    expect(isNeedsConfirmation(plain)).toBe(false);
  });

  it("finds a pending confirmation in the stored transcript only until the user answers", async () => {
    const pending = { status: "needs_confirmation", confirmation_id: "c".repeat(32), summary: "Change the domain", instructions: "x" };
    const msgs = [
      { role: "user", content: [{ type: "text", text: "change the domain" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "update_product", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: frameToolResult("update_product", pending) }] },
      { role: "assistant", content: [{ type: "text", text: "Please confirm." }] },
    ];
    expect(findPendingConfirmation(msgs, "c".repeat(32))?.summary).toBe("Change the domain");
    expect(findPendingConfirmation(msgs, "d".repeat(32))).toBeNull();
    expect(findPendingConfirmation([...msgs, { role: "user", content: [{ type: "text", text: "no" }] }], "c".repeat(32))).toBeNull();
  });
});

describe("crawl tools are restricted to verified domains", () => {
  it("queue_seo_audit refuses an unverified domain and links to verification", async () => {
    const ctx = await authFor(A);
    const conv = await createConversation(ctx, "crawl");
    const r = (await runTool(tool("queue_seo_audit"), "queue_seo_audit", { product: slugA, startUrl: "https://unverified-host.example/" }, ctx, actorOf(A), "en", { conversationId: conv.id })) as { queued: unknown; reason: string; link: string };
    expect(r.queued).toBeNull();
    expect(r.reason).toBe("DOMAIN_NOT_VERIFIED");
    expect(r.link).toContain("/discovery/domains");
  });
});

describe("tool timeouts really cancel", () => {
  const slow = defineTool({
    name: "slow_tool",
    label: "Slow",
    description: "test",
    permission: "read",
    kind: "read",
    input: z.object({}),
    run: async ({ tx }) => {
      await tx.execute(sql`select pg_sleep(20)`);
      return { ok: true };
    },
  });

  it("aborts the call and cancels the running statement on the server", async () => {
    const ctx = await authFor(A);
    const started = Date.now();
    await expect(runTool(slow, "slow_tool", {}, ctx, actorOf(A), "en", { conversationId: "x", timeoutMs: 800 })).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    // The statement was cancelled, not left running for 20 s.
    let running = 1;
    for (let i = 0; i < 20 && running > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      running = Number((await asSystem((tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where query like 'select pg_sleep(20)%' and state = 'active'`))).rows[0].n);
    }
    expect(running).toBe(0);
  });

  it("applies a per-statement timeout inside the tool transaction", async () => {
    const ctx = await authFor(A);
    const started = Date.now();
    await expect(runTool(slow, "slow_tool", {}, ctx, actorOf(A), "en", { conversationId: "x", timeoutMs: 10_000, statementTimeoutMs: 300 })).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("conversation store", () => {
  it("parallel appends never race for a seq", async () => {
    const ctx = await authFor(A);
    const conv = await createConversation(ctx, "race");
    const seqs = await Promise.all(Array.from({ length: 12 }, (_, i) => appendMessage(ctx, conv.id, { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `m${i}` }] })));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("summaries are appended as notes: stored history and the visible transcript are untouched", async () => {
    const ctx = await authFor(A);
    const conv = await createConversation(ctx, "summary");
    for (let i = 0; i < 4; i++) await appendMessage(ctx, conv.id, { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `m${i}` }] });
    const before = await withOrg(A.org.id, (tx) => tx.select().from(agentMessages).where(eq(agentMessages.conversationId, conv.id)));
    await appendSummary(ctx, conv.id, 2, "The user asked two things.");
    const after = await withOrg(A.org.id, (tx) => tx.select().from(agentMessages).where(eq(agentMessages.conversationId, conv.id)));
    expect(after).toHaveLength(before.length + 1);
    for (const row of before) expect(after.find((r) => r.id === row.id)).toEqual(row);
    const hist = await loadAgentHistory(ctx, conv.id);
    expect(hist!.summary).toEqual({ throughSeq: 2, text: "The user asked two things." });
    expect(hist!.messages).toHaveLength(4);
    expect((await loadConversation(ctx, conv.id))!.messages).toHaveLength(4);
    // Owner-scoped: another member (or organisation) cannot load it.
    expect(await loadAgentHistory(await authFor(B), conv.id)).toBeNull();
  });
});

describe("per-organisation monthly budget", () => {
  it("counts usage atomically and stops the agent with a clear message once the cap is reached", async () => {
    await withOrg(A.org.id, (tx) => saveIntegration(tx, A.actor, { provider: "ANTHROPIC", productId: null, config: {}, secret: { apiKey: "sk-ant-test-key" } }));
    await asSystem(async (tx) => {
      const org = (await tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) }))!;
      await tx.update(organizations).set({ settings: { ...org.settings, agent: { monthlyTokenCap: 1000 } } }).where(eq(organizations.id, A.org.id));
    });
    await Promise.all([withOrg(A.org.id, (tx) => recordAgentUsage(tx, A.org.id, { input: 400, output: 100 })), withOrg(A.org.id, (tx) => recordAgentUsage(tx, A.org.id, { input: 300, output: 200 }))]);
    const ctx = await authFor(A);
    const status = await withOrg(A.org.id, (tx) => agentBudget(tx, A.org.id, ctx.org.settings));
    expect(status).toMatchObject({ used: 1000, cap: 1000, exceeded: true, requests: 2, month: usageMonth() });

    const convsBefore = await withOrg(A.org.id, (tx) => tx.select().from(agentConversations).where(eq(agentConversations.organizationId, A.org.id)));
    const events: AgentEvent[] = [];
    for await (const e of runAgentTurn({ ctx, actor: A.actor, locale: "en", text: "Hello" })) events.push(e);
    expect(events).toEqual([{ type: "error", code: "budget", message: BUDGET_MESSAGE }]);
    // Nothing was stored and no model call was attempted.
    const convsAfter = await withOrg(A.org.id, (tx) => tx.select().from(agentConversations).where(eq(agentConversations.organizationId, A.org.id)));
    expect(convsAfter).toHaveLength(convsBefore.length);

    // Usage rows are tenant-isolated.
    expect(await withOrg(B.org.id, (tx) => tx.select().from(agentUsage).where(and(eq(agentUsage.organizationId, A.org.id))))).toEqual([]);
  });
});

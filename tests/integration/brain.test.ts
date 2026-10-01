import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { agentUsage, brainFindings, brainRuns, jobs, memberships, notifications, organizations, recommendations, seoAudits, seoIssues, users } from "@/db/schema";
import { AGENT_TOOLS } from "@/agent/tools";
import { runTool } from "@/agent/loop";
import { runBrain } from "@/brain/orchestrator";
import { SPECIALISTS } from "@/brain/types";
import { HANDLERS, scheduleRecurring } from "@/jobs/handlers";
import { enqueue } from "@/jobs/queue";
import { createSession, type AuthContext } from "@/lib/auth/service";
import type { Role } from "@/lib/auth/rbac";
import { hashPassword } from "@/lib/security/crypto";
import { latestDoneRun, runFindings } from "@/services/brain";
import { saveIntegration } from "@/services/visibility";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

/**
 * Beacon Brain end to end: deterministic runs without credentials, the LLM
 * phase against a fake Claude Messages API (ANTHROPIC_BASE_URL), the number
 * guard, notifications of new critical findings, "Run now" and "Propose"
 * through act() with their permissions, and the agent tools.
 */

let session: string | null = null;
class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "10.9.8.6" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Redirect("/404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const { runBrainAction, proposeBrainFindingAction } = await import("@/app/actions/brain");

async function act(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("_back", "/brain");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (e) {
    if (!(e instanceof Redirect)) throw e;
    const u = new URL(e.url, "http://x");
    return { ok: u.searchParams.get("ok"), error: u.searchParams.get("error") };
  }
  throw new Error("action did not redirect");
}

// ─── Fake Claude (non-streaming structured outputs) ─────────────────────
type Mode = "good" | "invented";
let mode: Mode = "good";
const calls: { system: string; data: string }[] = [];
let server: http.Server;
const ORIGINAL = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };

function fakeClaude(req: http.IncomingMessage, res: http.ServerResponse) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw) as { system: string; messages: { content: string }[] };
    const data = body.messages[0].content;
    calls.push({ system: body.system, data });
    const synthesis = body.system.includes("orchestrator of Beacon Brain");
    let out: unknown;
    if (synthesis)
      out =
        mode === "good"
          ? { summary_en: "Start with the first actions of the ranked plan, then connect the missing sources.", summary_fr: "Commencez par les premières actions du plan classé, puis connectez les sources manquantes." }
          : { summary_en: "Revenue will grow by 987654 EUR.", summary_fr: "Les revenus augmenteront de 987654 EUR." };
    else {
      const payload = JSON.parse(data.split("\n").slice(1, -1).join("\n")) as { findings: { id: string }[] };
      const n = payload.findings.length;
      out =
        mode === "good"
          ? { narrative_en: `${n} finding(s) need attention in this area.`, narrative_fr: `${n} constat(s) demandent de l’attention dans ce domaine.`, order: payload.findings.map((f) => f.id).reverse(), merges: [] }
          : { narrative_en: "Fixing this brings 987654 visits.", narrative_fr: "Corriger cela apporte 987654 visites.", order: [], merges: [] };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${uid()}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(out) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
  });
}

type Org = Awaited<ReturnType<typeof newOrg>>;
let A: Org;
let B: Org;
let productA: string;
const tokens = {} as Record<Role, string>;

async function member(orgId: string, role: Role) {
  const [u] = await asSystem(async (tx) => tx.insert(users).values({ email: `brain-${role.toLowerCase()}-${uid()}@example.test`, name: role, passwordHash: await hashPassword("correct horse battery 42") }).returning());
  await asSystem((tx) => tx.insert(memberships).values({ organizationId: orgId, userId: u.id, role }));
  return { id: u.id, token: (await createSession(u.id)).token };
}

async function authFor(o: Org, role: Role): Promise<AuthContext> {
  const org = (await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.id, o.org.id) })))!;
  return { user: { id: o.user.id, email: o.email, name: "Owner" }, org: { id: org.id, slug: org.slug, name: org.name, settings: org.settings, branding: org.branding }, role, sessionTokenHash: "test" };
}

const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
const callTool = async <T,>(o: Org, name: string, input: unknown, role: Role = "OWNER") => JSON.parse(JSON.stringify(await runTool(tool(name), name, input, await authFor(o, role), o.actor, "en", { conversationId: "c1" }))) as T;

const brainNotifications = (orgId: string) => withOrg(orgId, (tx) => tx.select().from(notifications).where(and(eq(notifications.organizationId, orgId), eq(notifications.kind, "BRAIN_CRITICAL"))));

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  server = http.createServer((req, res) => (req.method === "POST" && (req.url ?? "").startsWith("/v1/messages") ? fakeClaude(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  A = await newOrg("brain-a");
  B = await newOrg("brain-b");
  productA = (await seedCompleteProduct(A.org.id, { name: `Brain A ${uid()}`, domain: "brain-a.example" })).product.id;
  await seedCompleteProduct(B.org.id, { name: `Brain B ${uid()}` });
  // A completed audit with an open critical issue (no technical opportunity generated yet): a CRITICAL finding.
  await withOrg(A.org.id, async (tx) => {
    const [audit] = await tx.insert(seoAudits).values({ organizationId: A.org.id, productId: productA, status: "SUCCEEDED", startUrl: "https://brain-a.example/", pagesCrawled: 4, startedAt: new Date(), finishedAt: new Date() }).returning();
    await tx.insert(seoIssues).values({ organizationId: A.org.id, auditId: audit.id, productId: productA, url: "https://brain-a.example/", rule: "noindex_on_home", severity: "CRITICAL", message: "Home page is noindex" });
  });
  for (const role of ["VIEWER", "ANALYST", "EDITOR"] as Role[]) tokens[role] = (await member(A.org.id, role)).token;
}, 120_000);

afterAll(async () => {
  if (ORIGINAL.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = ORIGINAL.base;
  if (ORIGINAL.key !== undefined) process.env.ANTHROPIC_API_KEY = ORIGINAL.key;
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe("brain.run without credentials", () => {
  let firstRun: string;

  it("stores a deterministic run with coverage for the six areas, findings and estimates", async () => {
    const job = await enqueue("brain.run", {}, { organizationId: A.org.id, idempotencyKey: `brain-test:${uid()}` });
    const out = (await HANDLERS["brain.run"](job, { heartbeat: async () => undefined })) as { runId: string; ranked: number; unestimated: number; newCritical: number; summarySource: string; llmCalls: number };
    expect(out).toMatchObject({ summarySource: "DETERMINISTIC", llmCalls: 0 });
    firstRun = out.runId;
    const run = (await withOrg(A.org.id, (tx) => tx.query.brainRuns.findFirst({ where: eq(brainRuns.id, out.runId) })))!;
    expect(run).toMatchObject({ status: "DONE", trigger: "SCHEDULED", summarySource: "DETERMINISTIC", executiveSummary: null, narratives: {} });
    expect(run.llmUsage).toMatchObject({ calls: 0, skipped: "No Anthropic key (Settings, Integrations)" });
    expect(Object.keys(run.coverage).sort()).toEqual([...SPECIALISTS].sort());
    expect(run.coverage.technical_seo.coverage).toBe("PARTIAL"); // no search provider
    expect(run.coverage.ai_visibility).toMatchObject({ coverage: "NOT_CONNECTED", missing: ["An AI provider key (Settings, Integrations)"] });
    expect(run.estimationPower).toBeTruthy();

    const { ranked, unestimated } = await withOrg(A.org.id, (tx) => runFindings(tx, A.org.id, out.runId));
    expect(ranked.length + unestimated.length).toBe(out.ranked + out.unestimated);
    expect(ranked.length + unestimated.length).toBeGreaterThan(0);
    const critical = [...ranked, ...unestimated].find((f) => f.findingKey === `seo:open_issues:${productA}`)!;
    expect(critical).toMatchObject({ severity: "CRITICAL", specialist: "technical_seo", vars: { n: 1 } });
    expect(critical.target).toEqual({ productId: productA, opportunityType: "TECHNICAL" });
    expect(critical.estimate?.signups.key).toBe("expected_impact");
    // Ranks are 1..n within each list.
    expect(unestimated.map((f) => f.rank)).toEqual(unestimated.map((_, i) => i + 1));
    expect(out.newCritical).toBeGreaterThanOrEqual(1);
  });

  it("notifies members of new critical findings once", async () => {
    const first = await brainNotifications(A.org.id);
    expect(first.some((n) => n.userId === null)).toBe(true);
    expect(first.some((n) => n.userId === A.user.id)).toBe(true);
    const params = first.find((n) => n.userId === null)!.params as { items: { key: string; vars: Record<string, unknown>; href: string }[]; signals: string[] };
    expect(params.items[0]).toMatchObject({ key: "Fix {n} critical technical issues on {product}", href: "/brain" });
    expect(params.signals).toContain(`brain:seo:open_issues:${productA}`);

    const again = await runBrain(A.org.id, { trigger: "SCHEDULED" });
    expect(again.newCritical).toBe(0);
    const second = await brainNotifications(A.org.id);
    expect(second.map((n) => (n.params as { n: number }).n)).toEqual(first.map((n) => (n.params as { n: number }).n));
    expect((await withOrg(A.org.id, (tx) => latestDoneRun(tx, A.org.id)))!.id).toBe(again.runId);
    expect(again.runId).not.toBe(firstRun);
  });

  it("is invisible to another organisation", async () => {
    expect(await withOrg(B.org.id, (tx) => tx.select().from(brainRuns).where(eq(brainRuns.organizationId, A.org.id)))).toEqual([]);
    expect(await withOrg(B.org.id, (tx) => tx.select().from(brainFindings).where(eq(brainFindings.organizationId, A.org.id)))).toEqual([]);
    expect(await withOrg(B.org.id, (tx) => latestDoneRun(tx, B.org.id))).toBeNull();
  });

  it("is scheduled weekly for organisations with a product only", async () => {
    const empty = await newOrg("brain-empty");
    await scheduleRecurring(new Date("2026-10-05T10:00:00Z"));
    const queued = await asSystem((tx) => tx.select().from(jobs).where(and(eq(jobs.type, "brain.run"), sql`${jobs.idempotencyKey} like ${"%brain:%:2026-w%"}`)));
    const orgs = new Set(queued.map((j) => j.organizationId));
    expect(orgs.has(A.org.id)).toBe(true);
    expect(orgs.has(empty.org.id)).toBe(false);
    expect(queued.find((j) => j.organizationId === A.org.id)?.idempotencyKey).toMatch(new RegExp(`^${A.org.id}:brain:${A.org.id}:2026-w\\d+$`));
  });
});

describe("LLM phase (fake Claude)", () => {
  beforeAll(async () => {
    await withOrg(A.org.id, (tx) => saveIntegration(tx, A.actor, { provider: "ANTHROPIC", productId: null, config: {}, secret: { apiKey: "sk-ant-test-key" } }));
  });

  it("stores validated narratives and the executive summary, and counts the usage in the agent budget", async () => {
    mode = "good";
    calls.length = 0;
    const before = await withOrg(A.org.id, (tx) => tx.select().from(agentUsage).where(eq(agentUsage.organizationId, A.org.id)));
    const out = await runBrain(A.org.id, { trigger: "MANUAL" });
    expect(out.summarySource).toBe("LLM");
    expect(out.llm.rejected).toEqual([]);
    expect(calls.at(-1)!.system).toContain("orchestrator of Beacon Brain");
    expect(calls[0].data.startsWith('<tool_data tool="brain_')).toBe(true);
    const run = (await withOrg(A.org.id, (tx) => tx.query.brainRuns.findFirst({ where: eq(brainRuns.id, out.runId) })))!;
    expect(run.summarySource).toBe("LLM");
    expect(run.executiveSummary?.en).toBe("Start with the first actions of the ranked plan, then connect the missing sources.");
    expect(run.executiveSummary?.fr).toContain("plan classé");
    expect(run.narratives.technical_seo?.en).toMatch(/^\d+ finding\(s\) need attention in this area\.$/);
    expect(run.llmUsage).toMatchObject({ calls: calls.length, inputTokens: 100 * calls.length, outputTokens: 20 * calls.length });
    const after = await withOrg(A.org.id, (tx) => tx.select().from(agentUsage).where(eq(agentUsage.organizationId, A.org.id)));
    expect((after[0]?.requests ?? 0) - (before[0]?.requests ?? 0)).toBe(calls.length);
  });

  it("rejects narratives and a summary with an invented number and keeps the deterministic report", async () => {
    mode = "invented";
    calls.length = 0;
    const out = await runBrain(A.org.id, { trigger: "MANUAL" });
    expect(out.summarySource).toBe("DETERMINISTIC");
    expect(out.llm.rejected.length).toBe(calls.length);
    expect(out.llm.rejected.every((r) => r.reason.includes("987654"))).toBe(true);
    const run = (await withOrg(A.org.id, (tx) => tx.query.brainRuns.findFirst({ where: eq(brainRuns.id, out.runId) })))!;
    expect(run).toMatchObject({ summarySource: "DETERMINISTIC", executiveSummary: null, narratives: {} });
    const { ranked, unestimated } = await withOrg(A.org.id, (tx) => runFindings(tx, A.org.id, out.runId));
    expect(ranked.length + unestimated.length).toBeGreaterThan(0);
  });

  it("stays deterministic when the monthly agent budget is spent", async () => {
    await asSystem(async (tx) => {
      const org = (await tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) }))!;
      await tx.update(organizations).set({ settings: { ...org.settings, agent: { monthlyTokenCap: 1000 } } }).where(eq(organizations.id, A.org.id));
    });
    calls.length = 0;
    const out = await runBrain(A.org.id, { trigger: "MANUAL" });
    expect(calls).toHaveLength(0);
    expect(out.llm.skipped).toBe("Monthly agent budget reached");
    await asSystem(async (tx) => {
      const org = (await tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) }))!;
      await tx.update(organizations).set({ settings: { ...org.settings, agent: {} } }).where(eq(organizations.id, A.org.id));
    });
  });
});

describe("Run now and Propose (act, permissions)", () => {
  it("Run now needs job:run, queues one run at a time, and the job runs that run", async () => {
    session = tokens.VIEWER;
    expect(await act(runBrainAction)).toMatchObject({ error: "You do not have permission to do that." });
    session = tokens.ANALYST;
    expect(await act(runBrainAction)).toMatchObject({ ok: "Brain run queued. Results appear here when it finishes." });
    expect(await act(runBrainAction)).toMatchObject({ error: "A Brain run is already queued or running." });
    const queued = (await withOrg(A.org.id, (tx) => tx.select().from(brainRuns).where(and(eq(brainRuns.organizationId, A.org.id), eq(brainRuns.status, "QUEUED")))))!;
    expect(queued).toHaveLength(1);
    expect(queued[0].trigger).toBe("MANUAL");
    const [job] = await asSystem((tx) => tx.select().from(jobs).where(and(eq(jobs.type, "brain.run"), sql`${jobs.payload}->>'runId' = ${queued[0].id}`)));
    expect(job.organizationId).toBe(A.org.id);
    mode = "good";
    const out = (await HANDLERS["brain.run"](job, { heartbeat: async () => undefined })) as { runId: string };
    expect(out.runId).toBe(queued[0].id);
    expect((await withOrg(A.org.id, (tx) => tx.query.brainRuns.findFirst({ where: eq(brainRuns.id, queued[0].id) })))?.status).toBe("DONE");
  });

  it("Propose needs growth:write, creates one PROPOSED recommendation and refuses another organisation's finding", async () => {
    const latest = (await withOrg(A.org.id, (tx) => latestDoneRun(tx, A.org.id)))!;
    const { ranked, unestimated } = await withOrg(A.org.id, (tx) => runFindings(tx, A.org.id, latest.id));
    const f = [...ranked, ...unestimated].find((x) => x.findingKey === `seo:open_issues:${productA}`)!;
    session = tokens.ANALYST;
    expect(await act(proposeBrainFindingAction, { id: f.id })).toMatchObject({ error: "You do not have permission to do that." });
    session = tokens.EDITOR;
    expect(await act(proposeBrainFindingAction, { id: f.id })).toMatchObject({ ok: "Recommendation proposed. It waits for approval in Autopilot." });
    expect(await act(proposeBrainFindingAction, { id: f.id })).toMatchObject({ ok: "An open recommendation already exists for this finding." });
    const recs = await withOrg(A.org.id, (tx) => tx.select().from(recommendations).where(and(eq(recommendations.organizationId, A.org.id), eq(recommendations.kind, "BRAIN_TECHNICAL_SEO"))));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ status: "PROPOSED", requiresApproval: true, productId: productA, source: "ANALYST" });
    expect(recs[0].title).toMatch(/^Fix 1 critical technical issues on Brain A /);

    await runBrain(B.org.id, { trigger: "SCHEDULED", llm: false });
    const bRun = (await withOrg(B.org.id, (tx) => latestDoneRun(tx, B.org.id)))!;
    const bFinding = (await withOrg(B.org.id, (tx) => tx.select().from(brainFindings).where(eq(brainFindings.runId, bRun.id))))[0];
    expect(await act(proposeBrainFindingAction, { id: bFinding.id })).toMatchObject({ error: "Finding not found" });
    session = null;
  });
});

describe("agent tools", () => {
  it("get_brain_report returns the latest plan with links", async () => {
    const r = await callTool<{ run: { summarySource: string }; coverage: { area: string; coverage: string }[]; rankedPlan: { total: number }; notEstimable: { items: { title: string; link: string }[]; total: number }; link: string }>(A, "get_brain_report", {}, "VIEWER");
    expect(r.coverage.map((c) => c.area)).toHaveLength(6);
    expect(r.link).toBe("/brain");
    expect(r.notEstimable.items.some((i) => i.title.startsWith("Fix 1 critical technical issues on"))).toBe(true);
  });

  it("ask_specialist runs one specialist now", async () => {
    const r = await callTool<{ area: string; coverage: string; findings: { title: string; impact: unknown }[]; latestNarrative: unknown }>(A, "ask_specialist", { specialist: "technical_seo" }, "VIEWER");
    expect(r.area).toBe("Technical SEO");
    expect(r.findings.find((f) => f.title.startsWith("Fix 1 critical"))?.impact).toBeTruthy();
    await expect(callTool(A, "ask_specialist", { specialist: "astrology" })).rejects.toThrow("Invalid input");
  });

  it("run_brain needs job:run and queues a run", async () => {
    await expect(callTool(A, "run_brain", {}, "VIEWER")).rejects.toThrow("does not allow");
    // No run is active in B: queue one through the tool.
    const r = await callTool<{ status: string; link: string }>(B, "run_brain", {}, "ANALYST");
    expect(r).toMatchObject({ status: "queued", link: "/brain" });
    const again = await callTool<{ status: string }>(B, "run_brain", {}, "ANALYST");
    expect(again.status).toBe("already running");
    const audit = await withOrg(B.org.id, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs where organization_id = ${B.org.id} and action = 'brain.run.queue' and metadata->>'via' = 'agent'`));
    expect(Number(audit.rows[0].n)).toBe(1);
  });

  it("are registered with French labels and the expected kinds", () => {
    expect(tool("run_brain")).toMatchObject({ kind: "write", permission: "job:run" });
    expect(tool("get_brain_report")).toMatchObject({ kind: "read", permission: "read" });
    expect(tool("ask_specialist")).toMatchObject({ kind: "read", permission: "read" });
  });
});

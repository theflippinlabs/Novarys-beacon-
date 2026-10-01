import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb, withOrg, type Tx } from "@/db";
import { competitors, competitorWatches, competitorWatchSnapshots, jobs, notifications, productCompetitors, products } from "@/db/schema";
import { HANDLERS, scheduleRecurring } from "@/jobs/handlers";
import { enqueue } from "@/jobs/queue";
import { addWatch, assertCheckAllowed, listWatches, recentChanges, removeWatch, runCompetitorWatch, setWatchActive } from "@/services/competitor-watch";
import type { DigestParams } from "@/core/notifications/notifications";
import { AGENT_TOOLS } from "@/agent/tools";
import { newOrg, uid } from "./helpers";

const ORIGINAL_SSRF = process.env.BEACON_SSRF_ALLOW_PRIVATE;
let server: http.Server;
let base: string;
const requested: string[] = [];
let pricingHtml = "";
let pricingStatus = 200;

const pricing = (starter: string) =>
  `<!doctype html><html><head><title>Rival pricing</title><script>window.x = 1</script></head><body><nav><a href="/">Home</a></nav><main><h1>Pricing</h1><h2>Starter</h2><p>${starter}</p><h2>Pro</h2><p>$79/mo</p><ul><li>SSO</li></ul></main><footer>Rival Inc</footer></body></html>`;

let A: Awaited<ReturnType<typeof newOrg>>;
let B: Awaited<ReturnType<typeof newOrg>>;
let rivalA: string;
let rivalB: string;
let productA: string;
const qa = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(A.org.id, fn);
const fast = { hostDelayMs: 0 };

const changedNotifications = (userId: string | null) =>
  qa((tx) => tx.select().from(notifications).where(and(eq(notifications.organizationId, A.org.id), eq(notifications.kind, "COMPETITOR_PAGE_CHANGED")))).then((rows) => rows.filter((r) => r.userId === userId));

beforeAll(async () => {
  pricingHtml = pricing("$29/mo");
  server = http.createServer((req, res) => {
    requested.push(req.url ?? "");
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    switch (req.url) {
      case "/robots.txt":
        return send(200, "text/plain", "User-agent: NovarysBeacon\nDisallow: /blocked\n\nUser-agent: *\nAllow: /\n");
      case "/pricing":
        return send(pricingStatus, "text/html; charset=utf-8", pricingHtml);
      case "/features":
        return send(200, "text/html; charset=utf-8", "<main><h1>Features</h1><p>Moderation</p></main>");
      case "/blocked":
        return send(200, "text/html; charset=utf-8", "<main><p>Should never be fetched</p></main>");
      case "/data.json":
        return send(200, "application/json", '{"price": 1}');
      default:
        return send(404, "text/html", "<p>Not found</p>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BEACON_SSRF_ALLOW_PRIVATE = "true";
  A = await newOrg("cw-a");
  B = await newOrg("cw-b");
  rivalA = (await qa((tx) => tx.insert(competitors).values({ organizationId: A.org.id, name: "Rival", slug: `rival-${uid()}` }).returning()))[0].id;
  rivalB = (await withOrg(B.org.id, (tx) => tx.insert(competitors).values({ organizationId: B.org.id, name: "Rival B", slug: `rival-${uid()}` }).returning()))[0].id;
  productA = (await qa((tx) => tx.insert(products).values({ organizationId: A.org.id, slug: `p-${uid()}`, name: "Product A" }).returning()))[0].id;
  await qa((tx) =>
    tx.insert(productCompetitors).values({ organizationId: A.org.id, productId: productA, competitorId: rivalA, comparisonFacts: [{ dimension: "Starter price", product: "$19/mo", competitor: "$29/mo", sourceUrl: "https://rival.example/pricing" }] }),
  );
});

afterAll(async () => {
  if (ORIGINAL_SSRF === undefined) delete process.env.BEACON_SSRF_ALLOW_PRIVATE;
  else process.env.BEACON_SSRF_ALLOW_PRIVATE = ORIGINAL_SSRF;
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe("competitor page watch", () => {
  let pricingWatch: string;

  it("refuses a competitor of another organisation and non-https public URLs", async () => {
    await expect(qa((tx) => addWatch(tx, A.actor, { competitorId: rivalB, url: `${base}/pricing`, kind: "PRICING" }))).rejects.toThrow("Competitor not found");
    await expect(qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: "http://rival.example/pricing", kind: "PRICING" }))).rejects.toThrow("Only https:// URLs can be watched.");
    await expect(qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: "https://user:pw@rival.example/pricing", kind: "PRICING" }))).rejects.toThrow("credentials");
    expect(await qa((tx) => tx.select().from(competitorWatches).where(eq(competitorWatches.organizationId, A.org.id)))).toHaveLength(0);
  });

  it("adds a watch (local http only in development) and refuses duplicates", async () => {
    pricingWatch = (await qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: `${base}/pricing#plans`, kind: "PRICING" }))).id;
    await expect(qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: `${base}/pricing`, kind: "PRICING" }))).rejects.toThrow("already watched");
    const [w] = await qa((tx) => listWatches(tx, A.org.id));
    expect(w).toMatchObject({ url: `${base}/pricing`, status: "PENDING", competitorName: "Rival", snapshots: [] });
  });

  it("first fetch stores a baseline without any notification", async () => {
    const res = await runCompetitorWatch(qa, A.org.id, fast);
    expect(res).toMatchObject({ checked: 1, baselines: 1, changed: 0, deliveries: [] });
    const [w] = await qa((tx) => listWatches(tx, A.org.id));
    expect(w.status).toBe("OK");
    expect(w.httpStatus).toBe(200);
    expect(w.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.excerpt).toBe("Pricing Starter $29/mo Pro $79/mo SSO");
    expect(w.lastChangedAt).toBeNull();
    expect(w.snapshots.map((s) => s.kind)).toEqual(["BASELINE"]);
    expect(await changedNotifications(null)).toHaveLength(0);
  });

  it("a scheduled run skips pages checked recently; an unchanged page adds no snapshot", async () => {
    expect((await runCompetitorWatch(qa, A.org.id, fast)).checked).toBe(0);
    const res = await runCompetitorWatch(qa, A.org.id, { ...fast, watchIds: [pricingWatch] });
    expect(res).toMatchObject({ checked: 1, ok: 1, baselines: 0, changed: 0 });
    expect(await qa((tx) => tx.select().from(competitorWatchSnapshots).where(eq(competitorWatchSnapshots.watchId, pricingWatch)))).toHaveLength(1);
  });

  it("a fetch error keeps the last good content", async () => {
    pricingStatus = 503;
    const res = await runCompetitorWatch(qa, A.org.id, { ...fast, watchIds: [pricingWatch] });
    expect(res.failed).toBe(1);
    const [w] = await qa((tx) => listWatches(tx, A.org.id));
    expect(w).toMatchObject({ status: "HTTP_ERROR", httpStatus: 503, error: "HTTP 503", excerpt: "Pricing Starter $29/mo Pro $79/mo SSO" });
    pricingStatus = 200;
  });

  it("a change stores a snapshot with a factual diff and notifies members for review, without touching facts", async () => {
    pricingHtml = pricing("$35/mo");
    const res = await runCompetitorWatch(qa, A.org.id, { ...fast, watchIds: [pricingWatch] });
    expect(res).toMatchObject({ checked: 1, changed: 1 });
    const [w] = await qa((tx) => listWatches(tx, A.org.id));
    expect(w.status).toBe("OK");
    expect(w.error).toBeNull();
    expect(w.lastChangedAt).not.toBeNull();
    expect(w.snapshots.map((s) => s.kind)).toEqual(["CHANGED", "BASELINE"]);
    const changed = w.snapshots[0];
    expect(changed.previousHash).toBe(w.snapshots[1].contentHash);
    expect(changed.diff).toEqual({ linesAdded: 1, linesRemoved: 1, added: ["$35/mo"], removed: ["$29/mo"], pricesAppeared: ["$35/mo"], pricesDisappeared: ["$29/mo"] });

    const org = await changedNotifications(null);
    const mine = await changedNotifications(A.user.id);
    expect(org).toHaveLength(1);
    expect(mine).toHaveLength(1);
    const item = (mine[0].params as DigestParams).items[0];
    expect(item.key).toContain("Review it before updating any fact");
    expect(item.vars).toMatchObject({ competitor: "Rival", url: `${base}/pricing`, added: 1, removed: 1 });
    expect(mine[0].link).toBe(`/ai-visibility#watch-${pricingWatch}`);
    expect(mine[0].severity).toBe("MEDIUM");

    // Comparison facts stay as humans entered them.
    const link = await qa((tx) => tx.query.productCompetitors.findFirst({ where: and(eq(productCompetitors.productId, productA), eq(productCompetitors.competitorId, rivalA)) }));
    expect(link?.comparisonFacts).toEqual([{ dimension: "Starter price", product: "$19/mo", competitor: "$29/mo", sourceUrl: "https://rival.example/pricing" }]);

    const changes = await qa((tx) => recentChanges(tx, A.org.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ competitorName: "Rival", url: `${base}/pricing` });
    // Other organisations see nothing.
    expect(await withOrg(B.org.id, (tx) => recentChanges(tx, B.org.id))).toHaveLength(0);
    expect(await withOrg(B.org.id, (tx) => listWatches(tx, B.org.id))).toHaveLength(0);
  });

  it("the agent tool reads the change (read only)", async () => {
    const tool = AGENT_TOOLS.find((x) => x.name === "list_competitor_changes")!;
    expect(tool.kind).toBe("read");
    const out = (await qa((tx) => tool.run({ tx, ctx: { org: A.org, role: "VIEWER" }, actor: A.actor } as never, {} as never))) as { changes: { pricesAppeared: string[] }[] };
    expect(out.changes[0].pricesAppeared).toEqual(["$35/mo"]);
  });

  it("respects robots.txt: a disallowed page is recorded as blocked and never fetched", async () => {
    const id = (await qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: `${base}/blocked`, kind: "OTHER" }))).id;
    const res = await runCompetitorWatch(qa, A.org.id, { ...fast, watchIds: [id] });
    expect(res.blocked).toBe(1);
    const w = (await qa((tx) => listWatches(tx, A.org.id))).find((x) => x.id === id)!;
    expect(w.status).toBe("BLOCKED_BY_ROBOTS");
    expect(w.error).toContain("robots.txt");
    expect(w.contentHash).toBeNull();
    expect(w.snapshots).toHaveLength(0);
    expect(requested).not.toContain("/blocked");
  });

  it("records non-HTML pages without a baseline", async () => {
    const id = (await qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: `${base}/data.json`, kind: "OTHER" }))).id;
    await runCompetitorWatch(qa, A.org.id, { ...fast, watchIds: [id] });
    const w = (await qa((tx) => listWatches(tx, A.org.id))).find((x) => x.id === id)!;
    expect(w.status).toBe("NOT_HTML");
    expect(w.contentHash).toBeNull();
  });

  it("the job handler checks one page on demand (Check now), with politeness between requests", async () => {
    const id = (await qa((tx) => addWatch(tx, A.actor, { competitorId: rivalA, url: `${base}/features`, kind: "FEATURES" }))).id;
    await qa((tx) => assertCheckAllowed(tx, A.org.id, id));
    const job = await enqueue("competitor_watch.check", { watchId: id }, { organizationId: A.org.id, idempotencyKey: `test-cw:${id}` });
    const started = Date.now();
    const res = (await HANDLERS["competitor_watch.check"](job, { heartbeat: async () => undefined })) as { checked: number; baselines: number };
    expect(res).toMatchObject({ checked: 1, baselines: 1 });
    // robots.txt then the page on the same host: the default politeness delay applies.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    await expect(qa((tx) => assertCheckAllowed(tx, A.org.id, id))).rejects.toThrow("less than 10 minutes");
  }, 30_000);

  it("pausing stops checks; the weekly scheduler enqueues one run per organisation with active watches", async () => {
    const id = (await qa((tx) => tx.select({ id: competitorWatches.id }).from(competitorWatches).where(eq(competitorWatches.url, `${base}/features`))))[0].id;
    await qa((tx) => setWatchActive(tx, A.actor, id, false));
    await expect(qa((tx) => assertCheckAllowed(tx, A.org.id, id))).rejects.toThrow("paused");
    expect((await runCompetitorWatch(qa, A.org.id, { ...fast, watchIds: [id] })).checked).toBe(0);
    await scheduleRecurring(new Date());
    const queued = await systemDb().select().from(jobs).where(eq(jobs.type, "competitor_watch.check"));
    expect(queued.filter((j) => j.organizationId === A.org.id && j.idempotencyKey?.includes(":cwatch:"))).toHaveLength(1);
    expect(queued.filter((j) => j.organizationId === B.org.id)).toHaveLength(0);
  });

  it("removing a watch deletes its history; another organisation cannot remove it", async () => {
    await expect(withOrg(B.org.id, (tx) => removeWatch(tx, B.actor, pricingWatch))).rejects.toThrow("Watched page not found");
    await qa((tx) => removeWatch(tx, A.actor, pricingWatch));
    expect(await qa((tx) => tx.select().from(competitorWatchSnapshots).where(eq(competitorWatchSnapshots.watchId, pricingWatch)))).toHaveLength(0);
  });
});

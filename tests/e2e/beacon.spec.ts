import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end acceptance journey (serial, shared state):
 * login → create product (onboarding) → add query → generate opportunity →
 * technical audit → content draft → approve → publish → analytics.
 * Background jobs run in the embedded worker of the dev server.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { email: "owner@beacon.test", password: "correct-horse-battery-9", name: "Owner" };
const FIXTURE = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT ?? 3199}`;
let page: Page;

async function login(p: Page) {
  await p.goto("/login");
  await p.fill('input[name="email"]', OWNER.email);
  await p.fill('input[name="password"]', OWNER.password);
  await p.click("text=Sign in →");
  await expect(p.getByRole("heading", { name: "What needs my attention today?" })).toBeVisible();
}

/** Reload until `check` passes; background jobs complete asynchronously. */
async function eventually(p: Page, check: () => Promise<boolean>, { timeout = 90_000, interval = 1500 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await p.waitForTimeout(interval);
    await p.reload();
  }
  throw new Error("condition not met before timeout");
}

async function saveStep(p: Page, fields: Record<string, string>, opts: { select?: Record<string, string> } = {}) {
  for (const [name, value] of Object.entries(fields)) await p.fill(`[name="${name}"]`, value);
  for (const [name, value] of Object.entries(opts.select ?? {})) await p.selectOption(`select[name="${name}"]`, value);
  const step = new URL(p.url()).searchParams.get("step");
  await p.click("button:has-text('Save & continue →'), button:has-text('Finish & analyse →')");
  await p.waitForURL((u) => u.searchParams.get("step") !== step || !u.pathname.endsWith("/onboarding"), { timeout: 60_000 });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test("first run: create workspace, sign out, sign in", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.fill('input[name="orgName"]', "Novarys");
  await page.fill('input[name="name"]', OWNER.name);
  await page.fill('input[name="email"]', OWNER.email);
  await page.fill('input[name="password"]', OWNER.password);
  await page.click("text=Create workspace →");
  await expect(page.getByRole("heading", { name: "What needs my attention today?" })).toBeVisible();
  // Setup is no longer reachable once a user exists.
  await page.goto("/setup");
  await expect(page).not.toHaveURL(/\/setup/);
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill('input[name="email"]', OWNER.email);
  await page.fill('input[name="password"]', "wrong-password-123");
  await page.click("text=Sign in →");
  await expect(page.getByText("Invalid email or password.")).toBeVisible();
  await login(page);
  // Empty states never show fabricated numbers.
  await expect(page.getByText("Not connected").first()).toBeVisible();
});

test("create product through onboarding", async () => {
  await page.goto("/products");
  await page.fill('input[name="name"]', "Acme Live");
  await page.click("text=Add product →");
  await expect(page).toHaveURL(/\/products\/acme-live\/onboarding\?step=1/);
  await saveStep(page, {}, { select: { status: "LIVE" } });
  await saveStep(page, { domain: "acme-live.example", languages: "en, fr", supportedCountries: "FR, US", documentationUrl: "https://acme-live.example/docs", pricingUrl: "https://acme-live.example/pricing" });
  await saveStep(page, { category: "TikTok LIVE moderation software", keywords: "tiktok live moderation" }, { select: { apiAvailable: "false", freeTrial: "true" } });
  await saveStep(page, {
    shortDescription: "Acme Live helps TikTok agencies moderate LIVE streams in real time with filters and moderator dashboards.",
    fullDescription:
      "Acme Live is a moderation workspace for TikTok LIVE. Agencies connect their creators, define keyword filters and spam rules, and moderators review flagged comments from a shared dashboard while the stream is running. Every moderation action is logged so agency managers can review what happened after each LIVE session and coach their moderators.",
    howItWorks: "1. Connect a creator's TikTok LIVE. 2. Configure keyword filters and spam rules. 3. Moderators review flagged comments in the shared dashboard.",
  });
  await saveStep(page, {
    audiences: "TikTok agencies | Agencies that manage a roster of TikTok LIVE creators and need consistent moderation across every stream.\nTikTok creators | Individual creators who stream on TikTok LIVE and want spam and abuse kept out of their chat.",
    industries: "Creator economy | Agencies and creators earning revenue from live streaming on social platforms.",
  });
  await saveStep(page, {
    problems:
      "Spam floods LIVE chat | Spam and scam comments overwhelm chat during busy LIVE streams and drive viewers away.\nModeration is inconsistent | Different moderators apply different rules across creators in the same agency.\nNo moderation history | Agencies cannot review what was removed after a stream ends.",
  });
  await saveStep(page, {
    features:
      "Keyword filters | Block or flag comments that contain configurable keywords and phrases during TikTok LIVE streams.\nSpam detection | Detect repeated messages and link spam in LIVE chat and flag them for moderators automatically.\nModerator dashboard | A shared dashboard where moderators review flagged comments for every creator in the agency.\nModeration log | Every moderation action is recorded so managers can review each LIVE session afterwards.\nTeam roles | Assign moderators to creators and control who can moderate which streams in the agency.",
    useCases: "Agency moderation | Agencies apply one consistent moderation policy across all of their TikTok LIVE creators.",
  });
  await saveStep(page, { pricing: "Starter | 29 | EUR | MONTH | 14 | One creator\nAgency | 99 | EUR | MONTH | 14 | Up to 30 creators" });
  await saveStep(page, { competitors: "Rival Mod | rivalmod.example" });
  await saveStep(page, { integrations: "" });
  await saveStep(page, { sources: "Acme Live website | https://acme-live.example | WEBSITE\nAcme Live docs | https://acme-live.example/docs | DOCUMENTATION\nAcme Live pricing | https://acme-live.example/pricing | PRICING" });
  await saveStep(page, {}); // analytics (optional)
  await saveStep(page, {}); // search console (optional)
  await saveStep(page, { ctas: "Start free trial | https://acme-live.example/signup | TRY_FREE" });
  await expect(page).toHaveURL(/\/products\/acme-live(\?|$)/);
  await expect(page.getByText("Onboarding complete")).toBeVisible();
  // Product analysis (embedded worker) produces the query universe and page plan.
  await eventually(page, async () => (await page.locator("text=Fastest path to").count()) > 0 && (await page.locator('a[href="/discovery?product=acme-live"]').count()) > 0);
  await page.goto("/queries?product=acme-live&status=CANDIDATE");
  await eventually(page, async () => (await page.locator("tbody tr").count()) > 3);
});

test("verify facts in the knowledge graph", async () => {
  await page.goto("/products/acme-live/knowledge");
  await page.click("text=I verified the core descriptions");
  await expect(page.getByText("Core product description marked as human-verified.")).toBeVisible();
  // Verify every facet and plan (each click reloads the page).
  const buttons = page.locator("button:text-is('verify')");
  for (let n = await buttons.count(); n > 0; n--) {
    await buttons.first().click();
    await expect(buttons).toHaveCount(n - 1);
  }
  await expect(page.locator("button:text-is('verify')")).toHaveCount(0);
});

test("add a query and generate an opportunity", async () => {
  await page.goto("/queries?product=acme-live");
  await page.fill('input[name="query"]', "tiktok agency moderation software");
  await page.selectOption('select[name="importance"]', "5");
  await page.click("button:has-text('Add query')");
  await expect(page.getByText(/Added "tiktok agency moderation software" \(commercial/)).toBeVisible();
  await expect(page.locator("td", { hasText: "tiktok agency moderation software" })).toBeVisible();

  await page.goto("/opportunities?product=acme-live");
  await page.click("button:has-text('Regenerate')");
  await expect(page.getByText("Opportunity generation queued.")).toBeVisible();
  await eventually(page, async () => (await page.getByText('Cover "tiktok agency moderation software"').count()) > 0);
  await page.getByText('Cover "tiktok agency moderation software"').click();
  await expect(page.getByText("Recommended actions")).toBeVisible();
  await expect(page.getByText(/Create an audience page targeting/)).toBeVisible();
});

test("run a technical SEO audit", async () => {
  await page.goto("/discovery?product=acme-live");
  await page.fill('input[name="startUrl"]', `${FIXTURE}/`);
  await page.fill('input[name="maxPages"]', "10");
  await page.click("button:has-text('Run audit')");
  await expect(page).toHaveURL(/\/discovery\/audits\//);
  await eventually(page, async () => (await page.locator("text=✓ SUCCEEDED").count()) > 0);
  await expect(page.getByText("headings.h1_missing").or(page.getByText("meta.title_missing")).first()).toBeVisible();
  await expect(page.getByText("links.broken_internal")).toBeVisible();
  await expect(page.getByText("links.orphan")).toBeVisible();
});

test("create, approve and publish content", async () => {
  await page.goto("/discovery?product=acme-live");
  await page.click("button:has-text('Re-plan pages')");
  await expect(page.getByText(/Page plan synced/)).toBeVisible();
  const productRow = page.locator("tr", { hasText: "/acme-live" }).filter({ hasText: "PRODUCT" }).first();
  await expect(productRow.getByText("✓ passes gate")).toBeVisible();
  await productRow.locator("button:has-text('Draft')").click();
  await expect(page).toHaveURL(/\/content\//);
  await eventually(page, async () => (await page.getByText("Version 1").count()) > 0);
  await expect(page.getByText("✓ All claims supported")).toBeVisible();
  await expect(page.getByText("✓ SEO/GEO checks pass")).toBeVisible();

  // An invented claim must block approval.
  const body = await page.locator('textarea[name="body"]').inputValue();
  await page.fill('textarea[name="body"]', body.replace("## Who it is for", "Trusted by 10,000 agencies worldwide.\n\n## Who it is for"));
  await page.click("text=Save new version");
  await expect(page.getByText(/Saved v2/)).toBeVisible();
  await expect(page.getByText(/claim\(s\) need attention/)).toBeVisible();
  await expect(page.locator("button:has-text('Approve')")).toHaveCount(0);

  // Restore the factual version and approve.
  await page.fill('textarea[name="body"]', body);
  await page.click("text=Save new version");
  await expect(page.getByText(/Saved v3/)).toBeVisible();
  await page.click("button:has-text('Approve')");
  await expect(page.getByText("Approved. Publish when ready.")).toBeVisible();
  await page.click("button:has-text('Publish')");
  await expect(page.getByText(/Published\./)).toBeVisible();

  // Hosted page, sitemap and llms.txt reflect the publication.
  const pub = await page.request.get("/p/novarys/acme-live");
  expect(pub.status()).toBe(200);
  const html = await pub.text();
  expect(html).toContain("application/ld+json");
  expect(html).toContain('rel="canonical" href="https://acme-live.example/acme-live"');
  expect(await (await page.request.get("/p/novarys/sitemap.xml")).text()).toContain("https://acme-live.example/acme-live");
  expect(await (await page.request.get("/p/novarys/llms.txt")).text()).toContain("Acme Live");
  const entity = await (await page.request.get("/api/v1/entity/novarys/acme-live")).json();
  expect(entity.who.product).toBe("Acme Live");
});

test("tracking keys, events and analytics", async () => {
  await page.goto("/products/acme-live/tracking");
  await page.fill('input[name="name"]', "Website tracker");
  await page.click("button:has-text('Create key')");
  await expect(page.getByText("New key (shown once)")).toBeVisible();
  const key = (await page.locator("code").first().innerText()).trim();
  expect(key).toMatch(/^bpk_/);

  const origin = "https://acme-live.example";
  const send = (data: object, headers: Record<string, string> = {}) => page.request.post("/api/v1/events", { headers: { "content-type": "text/plain", origin, ...headers }, data: JSON.stringify({ key, product: "acme-live", ...data }) });
  const pv = await send({ type: "PAGE_VIEW", visitorId: "visitor_e2e_0001", url: `${origin}/acme-live?utm_source=newsletter&utm_medium=email`, referrer: "https://chatgpt.com/" });
  expect(pv.status()).toBe(202);
  expect((await pv.json()).channel).toBe("EMAIL");
  const ai = await send({ type: "PAGE_VIEW", visitorId: "visitor_e2e_0002", url: `${origin}/acme-live`, referrer: "https://chatgpt.com/" });
  expect((await ai.json()).channel).toBe("AI_REFERRAL");
  expect((await send({ type: "CTA_CLICK", visitorId: "visitor_e2e_0002", url: `${origin}/acme-live`, ctaId: "TRY_FREE" })).status()).toBe(202);
  // Browser keys cannot forge lifecycle events, nor be used from other origins.
  expect((await send({ type: "SIGNUP", visitorId: "visitor_e2e_0002" })).status()).toBe(403);
  expect((await send({ type: "PAGE_VIEW", visitorId: "visitor_e2e_0003" }, { origin: "https://evil.example" })).status()).toBe(403);

  await page.reload();
  await expect(page.locator("td", { hasText: "CTA_CLICK" }).first()).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What needs my attention today?" })).toBeVisible();
  // The Visitors KPI (links to /conversions) now shows measured data: 2 unique visitors.
  const visitors = page.locator('main a[href="/conversions"]').first();
  await expect(visitors).toContainText("Visitors");
  await expect(visitors).not.toContainText("Not connected");
  await expect(visitors).toContainText("2");
  await page.goto("/conversions");
  await expect(page.getByRole("heading", { name: "Conversion engine" })).toBeVisible();
  await page.goto("/products/acme-live");
  await expect(page.getByText("Fastest path to")).toBeVisible();
});

test("RBAC: a viewer cannot mutate", async () => {
  await page.goto("/settings");
  await page.fill('input[name="name"]', "Viewer");
  await page.fill('input[name="email"]', "viewer@beacon.test");
  await page.fill('input[name="password"]', "viewer-password-123");
  await page.click("button:has-text('Add member')");
  await expect(page.getByText("viewer@beacon.test added as viewer.")).toBeVisible();
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill('input[name="email"]', "viewer@beacon.test");
  await page.fill('input[name="password"]', "viewer-password-123");
  await page.click("text=Sign in →");
  await page.goto("/products");
  await expect(page.getByText("Add product →")).toHaveCount(0);
  await page.goto("/queries");
  await expect(page.locator('input[name="query"]')).toHaveCount(0);
});

test("language toggle switches the interface to French and back", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "fr", exact: true }).first().click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("navigation", { name: "Navigation principale" }).getByRole("link", { name: "Vue d’ensemble" })).toBeVisible();
  await page.getByRole("button", { name: "en", exact: true }).first().click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
});

test("agent: connect Claude, ask a question, the agent uses a tool and answers", async ({ page }) => {
  await login(page);
  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "What should we do today?" })).toBeVisible();

  // Without a key the agent explains how to connect it.
  await page.getByLabel("Message the agent").fill("What needs my attention?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("The agent needs an Anthropic API key")).toBeVisible();

  await page.goto("/settings/integrations");
  const form = page.locator('form:has(input[name="provider"][value="ANTHROPIC"])');
  await form.locator('input[name="apiKey"]').fill("sk-ant-test-key");
  await form.locator('button[type="submit"]').first().click();
  await expect(page.getByRole("status")).toContainText("Integration saved");

  await page.goto("/agent");
  await page.getByLabel("Message the agent").fill("What needs my attention?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Reading the overview")).toBeVisible();
  await expect(page.getByText("Your workspace has")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open products" })).toHaveAttribute("href", "/products");
  await expect(page).toHaveURL(/\/agent\/[0-9a-f-]{36}$/);

  // The conversation is saved and replays from history.
  await page.reload();
  await expect(page.getByText("Your workspace has")).toBeVisible();
  await expect(page.getByText("What needs my attention?").first()).toBeVisible();
});

test("edit and delete a product", async ({ page }) => {
  await login(page);
  await page.goto("/products");
  await page.fill('input[name="name"]', "Throwaway App");
  await page.getByRole("button", { name: "Add product →" }).click();
  await page.goto("/products/throwaway-app");
  await expect(page.getByRole("link", { name: "Continue editing →" })).toHaveAttribute("href", /\/products\/throwaway-app\/onboarding\?step=\d+/);

  // The logo is chosen from the device right next to the field, then saved with the step.
  await page.goto("/products/throwaway-app/onboarding?step=1");
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 13, g: 122, b: 236, alpha: 1 } } }).png().toBuffer();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await expect(page.locator('input[name="logoUrl"]')).toHaveValue(/\/api\/media\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(page.locator('input[name="logoUrl"]')).toHaveValue(/\/api\/media\//);
  await page.goto("/products/throwaway-app");

  // A wrong confirmation is refused; the exact name deletes.
  await page.locator('input[name="confirm"]').fill("something else");
  await page.getByRole("button", { name: "Delete product" }).click();
  await expect(page.getByRole("status")).toContainText("Type the product name exactly");
  await page.locator('input[name="confirm"]').fill("Throwaway App");
  await page.getByRole("button", { name: "Delete product" }).click();
  await expect(page).toHaveURL(/\/products\?ok=/);
  await expect(page.getByRole("status")).toContainText("deleted");
  await expect(page.getByRole("link", { name: "Throwaway App" })).toHaveCount(0);
});

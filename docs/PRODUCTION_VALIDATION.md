# Novarys Beacon: Phase 2 production validation

Date: 2026-10-01. Branch `claude/beacon-platform`. This document records the final validation of Phase 2 (§40): automated checks, then the 16 workflows walked by hand in a real browser. A workflow is PASS only when it was observed working end to end; anything blocked by a missing external connection is PARTIAL, with the remaining step named.

## 1. Automated checks

| Check | Result | Evidence |
|---|---|---|
| Typecheck (`pnpm typecheck`) | PASS | `tsc --noEmit`, no errors |
| Lint (`pnpm lint`) | PASS | `eslint .`, no warnings |
| Unit tests (`pnpm test`) | PASS | 555 of 555 (i18n completeness and no long dashes included) |
| Integration tests (`pnpm test:integration`) | PASS | 403 of 403 on PostgreSQL 16 with the real roles: tenant isolation over every tenant table, action authorization matrix, RLS forced |
| Production build (`pnpm build`) | PASS | Next.js 16 production build succeeds |
| E2E (`pnpm test:e2e`) | PASS | 11 of 11 Playwright journeys (the suite runs against `next dev`; the production build itself was exercised by the workflow validation in section 2) |
| Database migration validation | PASS | Migrations 0000 to 0017 apply on an empty database; a database built from the hand-written migrations and one built from the Drizzle-generated SQL have identical schemas (`pg_dump -s` diff: only one column position differs); `drizzle-kit generate` reports "No schema changes" |
| Security checks | PASS | See `docs/SECURITY_AUDIT.md`: separate BYPASSRLS system role, startup refuses superuser or BYPASSRLS app roles, strict production environment, nonce CSP and HSTS, SSRF-safe fetches, rate limits, tenant isolation tests. No secrets in the repository (staged diff scanned before each commit) |
| Production deploy (Railway) | PASS | Web and worker deployments of each Phase 2 commit reached SUCCESS; pre-deploy log: roles provisioned, "migrations applied", `startup.checks_passed` on web and worker |

**Deploy finding fixed during validation.** The worker and the web service deploy in parallel, and only the web pre-deploy runs migrations, so the Wave 2 worker briefly queried a column that did not exist yet (one `error.reported` at 15:13:04, recovered on the next tick). The worker now waits until the database has every migration of its build before starting (`src/jobs/migrations-ready.ts`, unit tested); the next deploy started cleanly.

## 2. Workflow validation

**How it was run.** The production build (`next start`, `NODE_ENV=production`, real encryption and hash secrets, embedded worker) on a fresh PostgreSQL database migrated with the application role, driven through the UI in Chromium by a serial Playwright script, as a user would: server actions and the public event APIs only, database read only to collect evidence. A local fixture website stood in for the product site, and a local stub stood in for the Claude API. The run was done twice: run 1 found bugs (section 3), which were fixed; run 2 repeated the affected workflows on a fresh database. Screenshots and raw evidence were kept with the run (65 screenshots in run 1, 22 in run 2).

| # | Workflow | Status | Evidence | Remaining blocker |
|---|---|---|---|---|
| 1 | Create organization | PASS | Wrong setup token refused ("Invalid setup token."); correct token lands on "What needs my attention today?"; `/setup` then redirects away. DB: 1 organization, 1 user, 1 OWNER membership. The home page shows "Not connected" everywhere and no numbers. | None |
| 2 | Add product | PASS | Onboarding v2 walked from product through website, product information sub-steps (category to conversion URLs) to verify knowledge, which listed the facts waiting for verification. DB: product created, 5 features, 2 pricing plans, 3 sources, per-step status recorded. | None |
| 3 | Crawl authorized product website | PARTIAL | In production Beacon only crawls a domain whose ownership is verified (DNS TXT or `/.well-known/beacon-verification.txt`), and refuses private addresses and non-standard ports. The validation could not own a real domain, so every attempt was correctly refused ("acme-live.example is not a verified domain for this workspace", "Port 3198 is not allowed"); 0 requests reached the fixture. The crawler itself (robots.txt, sitemap, broken links, missing titles, orphan pages, rule catalogue with what, why, affected URLs and how to fix) is exercised end to end by the E2E journey "run a technical SEO audit" and by the integration suite, against a local site with private addresses allowed (a test-only setting that production refuses at boot). | The owner verifies the product domain in Discovery → Domains (`/discovery/domains`) or the onboarding website step (TXT record or verification file), then runs the crawl. |
| 4 | Generate product knowledge | PARTIAL | Human path PASS: every fact and plan was verified against a named source ("Core product description marked as human-verified."), and verification needs the `fact:verify` permission. Website extraction is gated on the same verified domain ("Available once the domain is verified."), so it could not run here; the integration suite covers it (UNVERIFIED proposals with their source URL, robots.txt respected, unverified domain refused, accept and reject). | Same as workflow 3: a verified domain. |
| 5 | Create query universe | PASS | Run 2: "25 candidate queries in 8 clusters", 12 activated by a person, a manual query added. DB: 13 ACTIVE queries, 7 clusters. Problem-derived queries are grammatical after the fix ("how to deal with no moderation history"). | None |
| 6 | Detect content gap | PASS | 6 gaps, e.g. "tiktok agency moderation software · NONE coverage · HIGH relevance · FEATURE PAGE · Search demand: Unknown (no search provider data)". No search volume is invented. | Search demand stays "Unknown" until Search Console or Bing is connected. |
| 7 | Generate opportunity | PASS | "Opportunity created from the content gap." The detail page shows evidence, the transparent score (impact × confidence × urgency ÷ effort) with a rationale per factor, "Generated by rules" and a next action. DB: 8 open opportunities. | None |
| 8 | Generate content draft | PASS | Run 2: draft generated from the gap by the rules generator. Title and H1 "TikTok agency moderation software \| Acme Live", body built only from verified facts, provenance "Prompt / rules version: content-rules-v2". | LLM rewriting needs an Anthropic key (rules generation works without it). |
| 9 | Fact-check it | PASS | "All claims supported" (21 claims, each tied to a source URL). Adding "Trusted by 10,000 agencies worldwide." produced "1 blocking" and hid Approve; removing it cleared the block. | None |
| 10 | Approve it | PASS | Run 2: the freshly generated version 1 passed fact check, quality gate and SEO/GEO checks with no human edit; "Approved. Publish when ready." DB: status APPROVED with approver and timestamp; audit log `content.create`, `content.generate`, `content.approve`. (Run 1 failed here; see section 3.) | None |
| 11 | Verify analytics state | PASS | Without GA4: 27 "Not connected" states on the home page (including "AI referral sessions (GA4)"), "Nothing connected yet" on Integrations, "NOT CONNECTED" in onboarding. DB: 0 GA4 rows. No fabricated number anywhere. | GA4 data needs the Google OAuth client (section 4). |
| 12 | Verify conversion tracking | PASS | Publishable and secret keys created (the key is shown once: gone after a reload). Page views and a CTA click accepted (202) with channels EMAIL, AI_REFERRAL, ORGANIC_SEARCH; lifecycle events with the publishable key refused (403 "requires a secret key"); unknown origin refused (403); `SIGNUP_COMPLETED` and `TRIAL_STARTED` with the secret key accepted; repeated idempotency key returned `duplicate:true`. DB: 8 events, 3 visitors. Funnel: page view 3, CTA 1 (33.3%), signup 2 (n/a, not a subset of CTA clicks, explained in a footnote), trial 1 (50.0%). | None |
| 13 | Verify attribution | PASS | Before any conversion: "No conversion credited in this period." After the signups: last non-direct touch AI referral 2, organic search 1; first touch AI 2, email 1; linear and position-based AI 2, email 0.5, organic 0.5. Each model shows its rule and "correlation, not causation". DB `attribution_credits` matches exactly. | Revenue attribution needs Stripe webhooks (configured per product). |
| 14 | Run AI visibility experiment | PARTIAL | Without a provider the page says "NOT CONNECTED: No AI provider configured" and offers no Run button. With a key pointed at the local Claude stub the full path ran (sampled tests queued, response stored with provider, model and web-search flag, "No known product or competitor was mentioned", weekly schedule picked it up), but those responses came from the stub, so no real visibility was measured. | Add a real Anthropic key in Settings → Integrations. |
| 15 | Generate daily briefing | PASS | "Briefing generated." Unconnected sources shown as "Not connected", top 5 actions taken from the real opportunities and drafts, each linking to its page. DB: briefings stored (`rules-v1`), one generated by the worker schedule and one on demand. | None |
| 16 | Generate weekly report | PARTIAL | "Generate now" produced the report for the last complete week (2026-09-24 to 2026-09-30) against the week before; CSV, Markdown and JSON exports return 200 as attachments without long dashes; content exports (ZIP and Markdown) work. All the validation data was created on 2026-10-01, inside the current week, so the report's sections were observed only in their empty "no data" state; a report with populated sections was not observed in the browser (the integration suite covers it with seeded data). | None technical: rerun after a full week of data. |

**Summary:** 12 PASS, 4 PARTIAL, 0 FAIL. The four PARTIAL workflows wait on external authorization (domain ownership, an AI provider key) or on elapsed time (a full week of data), not on missing code.

## 3. Defects found by the validation and fixed

| Found in run 1 | Fix | Verified |
|---|---|---|
| A draft generated from a content gap failed Beacon's own `query_in_title` rule (H1 and meta title came from the description), so it could never be approved without a human edit | Generated titles target the query (`targetedTitle`, shared `queryTermCoverage`) | Run 2: approved with no edit; integration test |
| Draft title repeated the product name, first line lower-cased it, the CTA code "TRY_FREE" was visible, provenance read "Unknown" | Name helpers, CTA markers become a `data-beacon-cta` attribute, rules version recorded and shown | Run 2 text verbatim; unit and integration tests |
| Ungrammatical generated queries and opportunity titles ("how to spam floods live chat") | "how to" only for actions and noun phrases | Run 2 queries verbatim; unit tests |
| Funnel step rate of 200% | Rate is n/a when a step is not a subset of its base, with a footnote | Run 2; unit test |
| AI visibility chart repeated its x-axis label | Distinct tick positions | Unit test |
| "Shown once" API key readable on reload for 2 minutes | Key cookie consumed on display | Run 2; E2E |
| Flash message stayed in the URL | Flash parameters removed from the address bar after display | Run 2; E2E |
| Run 2: unrounded "25.444… completeness points missing" on an opportunity; `{cta:TRY_FREE}` left in Markdown exports | Rounded; markers stripped from exports | Unit test |
| Deploy race between worker and migrations | Worker waits for its migrations | Railway logs |

## 4. Remaining connection steps (no fake data replaces them)

1. **Google (Search Console and GA4):** create an OAuth client in Google Cloud, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` on the web and worker services, redirect URI `${BEACON_BASE_URL}/api/integrations/google/callback`, then "Connect with Google" in Settings → Integrations. (A service account JSON also works without OAuth.)
2. **Email notifications and invitations:** set `RESEND_API_KEY` and `BEACON_EMAIL_FROM`. Until then, invitations give a copyable link and email notifications are off; in-app and webhook notifications work.
3. **Beacon agent, LLM rewriting and AI visibility:** add an Anthropic key in Settings → Integrations (stored encrypted).
4. **Crawls and website extraction:** verify each product domain in Discovery → Domains (`/discovery/domains`).
5. **Optional:** Bing Webmaster key, Stripe webhook secret per product, `BEACON_AGENT_MONTHLY_TOKEN_CAP`, `BEACON_ANTHROPIC_WEB_SEARCH`.

## 5. Known limits observed

- Four "Failed to load resource: 404" browser console messages were seen once in run 2 (onboarding website step, opportunities, content, tracking); a targeted repeat of those pages and actions logged none, nothing visibly broke, and the resource was not identified.
- On the onboarding page, which refreshes itself while a crawl runs, a flash message stays visible until the person leaves the page.
- Zero is formatted "0.0%" in the funnel and "0.00%" in one conversion table.

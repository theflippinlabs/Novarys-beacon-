# Novarys Beacon: Phase 2 audit

Audit date: 2026-10-01. Scope: the whole repository at commit `f12e9cc`, before any Phase 2 change.

Method: five independent read-only reviews (data integrity and dashboards; discovery engines; integrations and measurement; content and growth loop; security, tenancy and performance). Every finding was checked against the actual code path (UI, action or route, service, database or provider), not against comments, labels or UI copy. Line numbers refer to the audited commit.

Status vocabulary: WORKING, PARTIALLY WORKING, MOCKED, HARDCODED, BROKEN, NOT IMPLEMENTED, UNUSED, DUPLICATED, SECURITY RISK.
Priority: P0 (security, data integrity, broken), P1 (core Phase 2 capability), P2 (important), P3 (nice to have).

## Summary

| # | System | Status | Priority |
|---|---|---|---|
| 1 | Fake data in production paths | WORKING, with silent defaults that invent facts | P0 (pricing parse) |
| 2 | Command center KPIs and daily briefing | PARTIALLY WORKING | P1 |
| 3 | Empty states | PARTIALLY WORKING | P2 |
| 4 | Knowledge graph provenance and completeness | PARTIALLY WORKING, data integrity risk | P0 (re-verification) |
| 5 | Beacon Score | PARTIALLY WORKING | P1 |
| 6 | Launch checklist and launch mode | PARTIALLY WORKING | P2 |
| 7 | Onboarding flow | PARTIALLY WORKING | P1 |
| 8 | Weekly executive report | PARTIALLY WORKING | P2 |
| 9 | Notifications | NOT IMPLEMENTED | P2 |
| 10 | Command palette | NOT IMPLEMENTED | P3 |
| 11 | Mobile layouts | PARTIALLY WORKING | P2 |
| 12 | Website crawler | PARTIALLY WORKING, SECURITY RISK | P0 |
| 13 | Technical SEO auditor | PARTIALLY WORKING | P1 |
| 14 | Query universe | PARTIALLY WORKING | P0 (uniqueness bug) |
| 15 | Content gap engine | PARTIALLY WORKING | P1 |
| 16 | GEO / AEO knowledge layer | WORKING, provenance gap | P1 |
| 17 | AI visibility lab | PARTIALLY WORKING | P0 (trend bug) |
| 18 | Citation analysis | NOT IMPLEMENTED | P1 |
| 19 | Competitor intelligence | PARTIALLY WORKING | P2 |
| 20 | Opportunity engine | PARTIALLY WORKING, BROKEN inputs | P0 (GSC aggregation) |
| 21 | Internal linking engine | NOT IMPLEMENTED | P2 |
| 22 | Sitemap control center | PARTIALLY WORKING | P1 |
| 23 | Google Search Console adapter | PARTIALLY WORKING, BROKEN consumption | P0 |
| 24 | Bing Webmaster and provider abstraction | PARTIALLY WORKING | P1 |
| 25 | GA4 analytics | PARTIALLY WORKING | P1 |
| 26 | Conversion tracking SDK / API | PARTIALLY WORKING, SECURITY RISK | P0 |
| 27 | Attribution engine | PARTIALLY WORKING | P1 |
| 28 | Stripe revenue ingestion | PARTIALLY WORKING, BROKEN on new API shape | P0 |
| 29 | Integration health | PARTIALLY WORKING | P0 (silent sync stop) |
| 30 | Background jobs and worker | WORKING, duplicate execution risk | P1 |
| 31 | Ecosystem graph and cross-sell | PARTIALLY WORKING | P1 |
| 32 | Referrals, affiliates, revenue pages | WORKING | P2 |
| 33 | Content engine | PARTIALLY WORKING, data integrity risk | P0 |
| 34 | Content fact checker | PARTIALLY WORKING | P0 |
| 35 | Content quality gate | PARTIALLY WORKING | P1 |
| 36 | Content repurposing | NOT IMPLEMENTED | P2 |
| 37 | Distribution intelligence | PARTIALLY WORKING | P1 |
| 38 | Autopilot loop | PARTIALLY WORKING (stops at APPROVE) | P1 |
| 39 | Growth experiments | PARTIALLY WORKING | P2 |
| 40 | Beacon agent | WORKING, moderate security risk | P1 |
| 41 | Duplicated and unused code | DUPLICATED, UNUSED | P3 |
| 42 | Sessions and passwords | WORKING | P1 (spoofable IP) |
| 43 | RBAC on server actions | WORKING, verification permission gap | P1 |
| 44 | Org scoping of foreign keys from forms | PARTIALLY WORKING | P2 |
| 45 | Job idempotency keys | SECURITY RISK (cross-tenant DoS) | P2 |
| 46 | RLS coverage and roles | WORKING, bypass is a convention | P0 (role checks), P1 |
| 47 | SQL injection, XSS, CSRF, open redirects, SSRF | WORKING, minor gaps | P3 |
| 48 | Secrets, encryption, logging | WORKING, no key rotation | P2 |
| 49 | Environment variables | PARTIALLY WORKING | P1 |
| 50 | Rate limiting | PARTIALLY WORKING | P1 |
| 51 | File uploads and media | WORKING | P2 |
| 52 | Security headers (CSP, HSTS) | SECURITY RISK | P1 |
| 53 | Public exposure control | UNUSED, SECURITY RISK | P2 |
| 54 | Tenant isolation tests | PARTIALLY WORKING | P1 |
| 55 | Deployment configuration | PARTIALLY WORKING | P1 |
| 56 | Performance (indexes, N+1, pagination) | PARTIALLY WORKING | P2 |
| 57 | Dependencies | WORKING (`pnpm audit --prod`: no known vulnerabilities) | P3 |

## P0 findings at a glance

1. **Inflated Search Console numbers.** GSC sync stores a 28-day per-query aggregate on a new day every day; `services/metrics.ts:59-65` (branded impressions KPI) and `services/opportunities.ts:18-31` (opportunity evidence and thresholds) sum all overlapping snapshots, inflating impressions and clicks up to about 30x. Position is last-row-wins.
2. **Publishable tracking key can write identity and consent.** `services/tracking.ts:139-143` accepts `identityRef`, `emailHashInput` and `consent` with a public key; anyone can forge consent or hijack referral attribution and commissions.
3. **Edited descriptions published as verified.** Onboarding steps 1 to 4 (`actions/products.ts:82-95`) change verified values without clearing `lastVerifiedAt`, so later edits are exposed through `verifiedOnly`, the entity API and `/ask`.
4. **Fabricated prices.** `core/knowledge/parse.ts:40` turns "Contact sales" into a price of 0, and missing currency or interval silently become EUR and MONTH.
5. **Unverified facts reach public pages.** Content generation and fact checking accept UNVERIFIED and NEEDS_REVIEW facts (`core/content/generate.ts`, `fact-check.ts`); hosted pages serve that content. An LLM rewrite can also drop editor TODO lines that block approval (`ai/tasks.ts:86-91`).
6. **Fact checker misses claims** in headings, meta fields and short sentences, matches numbers as substrings, and does not validate pricing interval, currency or freshness.
7. **Integration sync stops forever after one error.** The scheduler only enqueues `CONNECTED` integrations (`jobs/handlers.ts:112-113`); saving an integration marks it `CONNECTED` without a connection test (`services/visibility.ts:35`).
8. **Stripe revenue can be lost, overwritten or double counted:** unmapped events answered 200 and dropped, out-of-order replays overwrite subscriptions, current invoice shape likely unsupported, cumulative refunds double counted.
9. **Crawler:** robots rules evaluated for Googlebot instead of Beacon's user agent, robots 5xx treated as allow-all, any member can crawl any public site (no domain verification), and long crawls can run twice (no job heartbeat).
10. **Query universe drops queries across products** (`queries_uq` misses `product_id`), and the product AI visibility trend counts all organisation tests (`aiVisibilityTrend` missing product filter).
11. **Database role not enforced in production:** provisioning silently skips without `DATABASE_ADMIN_URL`; nothing refuses to start as a superuser or BYPASSRLS role; `docker-compose.yml` runs as a superuser.

## Detailed findings

### 1. Fake data in production paths
- STATUS: WORKING (secondary: PARTIALLY WORKING)
- EVIDENCE: no mock, fake, demo or random datasets in `src/` (Math.random only for a React key and job jitter). No DEMO mode. Seed (`src/db/seed.ts`) runs only through `pnpm db:seed`, never in `release`. Silent defaults: `core/knowledge/parse.ts:40` (non-numeric price becomes 0), `parse.ts:45-46` (currency EUR, interval MONTH), `services/metrics.ts:98-115` and `app/(app)/page.tsx:67` (mixed currencies summed under one label), `core/discovery/plan.ts:147` (changelog treated as VERIFIED), `plan.ts:29-30` (domain cited as a source nobody linked), `core/geo/entity.ts:108` (constant confidence 0.9 / 0.6), `jobs/handlers.ts:94` (`metrics.rollup` no-op).
- PROBLEM: small fabrications break "fake nothing".
- FIX REQUIRED: price null unless numeric; no currency or interval defaults; changelog verification column; no implicit domain source; KPIs per currency; confidence derived from verification, source and age; remove `metrics.rollup`; isolate seed as an explicit demo fixture.
- PRIORITY: P0 (pricing), P1 (rest)

### 2. Command center KPIs and daily briefing
- STATUS: PARTIALLY WORKING
- EVIDENCE: `services/metrics.ts` infers availability from data rows, not integration state (l.38, 82, 137-141); product KPIs use organisation-wide revenue and test checks (l.89, 106); covered queries and published counts always numeric; attention items computed live (`services/overview.ts:51-70`), no persisted briefing, no "since previous analysis" deltas, no top 5 cap.
- PROBLEM: NOT CONNECTED, NO DATA YET and a measured 0 are collapsed; no daily briefing artifact.
- FIX REQUIRED: three-state KPI model driven by integrations and tracker state; product-scoped checks; `briefings` table and `briefing.generate` job with deltas and top 5 actions.
- PRIORITY: P1

### 3. Empty states
- STATUS: PARTIALLY WORKING
- EVIDENCE: `EmptyState` (`components/ui/index.tsx`) is free text; many call sites lack a CTA (opportunities, discovery, content, distribution, autopilot, queries, referrals, conversions); filtered and never-generated look the same.
- FIX REQUIRED: structured `what / why / action` empty state with variants not_connected, no_data_yet, filtered; update call sites.
- PRIORITY: P2

### 4. Knowledge graph provenance and completeness
- STATUS: PARTIALLY WORKING (data integrity risk)
- EVIDENCE: facets, pricing, FAQs and proofs carry `sourceId` and `verification` (UNVERIFIED, NEEDS_REVIEW, VERIFIED, REJECTED); no verified date, verifier, confidence, OUTDATED or CONFLICTING; scalar product fields share one `lastVerifiedAt`; changelog has no verification; `product_sources.lastCheckedAt` never written; any `product:write` member can set VERIFIED without a source (`actions/products.ts:159-166`); wizard edits keep `lastVerifiedAt`; completeness is count-based, ignores verification, proofs and documentation, no per-section view.
- FIX REQUIRED: per-claim `verified_at`, `verified_by`, `confidence`, statuses OUTDATED and CONFLICTING; changelog verification; verification requires a source and a dedicated permission; reset verification on edit; source liveness job; per-section completeness (identity, features, pricing, use cases, proof, documentation) with visible formula.
- PRIORITY: P0 (re-verification), P1

### 5. Beacon Score
- STATUS: PARTIALLY WORKING
- EVIDENCE: `core/score/beacon-score.ts` has 7 components with reasons and fixes; unmeasurable signals score 0 instead of being excluded; free comparison points when none planned; AI mentions counted organisation-wide (`services/score.ts:37-41`); completeness counts unverified facts; Bing counted as Search Console (`score.ts:78`); live versus stored score differ between pages.
- FIX REQUIRED: `measurable` flag and rescaling with "not measured: connect X"; product-scoped AI mention rate; verified-weighted completeness; diff against previous stored score; one source of truth.
- PRIORITY: P1

### 6. Launch checklist and launch mode
- STATUS: PARTIALLY WORKING
- EVIDENCE: 11 real checks in `services/onboarding.ts:56-86`; "product page published" counts any page; no launch date or mode.
- FIX REQUIRED: Phase 2 checklist items (verified knowledge, sitemap and llms.txt, structured data, entity endpoint, Bing, AI baseline, distribution prepared, referral link, revenue connected, no critical issues); launch mode with pre-launch, launch day and post-launch.
- PRIORITY: P2

### 7. Onboarding flow
- STATUS: PARTIALLY WORKING
- EVIDENCE: 14 manual data-entry steps then a silent `product.analyze` job; skipped steps shown as done; progress hidden on mobile; no website extraction, verification step, initial crawl, query universe, gap or opportunity review, or score reveal.
- FIX REQUIRED: Phase 2 sequence with per-step status, website extraction proposing UNVERIFIED facts with crawled sources, inline job status, mobile progress.
- PRIORITY: P1

### 8. Weekly executive report
- STATUS: PARTIALLY WORKING
- EVIDENCE: weekly `growth_reports` with period comparison (`services/autopilot.ts`, `core/autopilot/analyst.ts`); no export; recommendations re-inserted every run; every organisation event attached to every metric change; English-only text.
- FIX REQUIRED: export (CSV and print view), dedupe, product-scoped correlation, sections for score, opportunities, content and per-product KPIs.
- PRIORITY: P2

### 9. Notifications
- STATUS: NOT IMPLEMENTED
- EVIDENCE: no notification tables, jobs, mailer or webhook (only the error-tracking webhook).
- FIX REQUIRED: `notifications` and `notification_preferences` tables, evaluation job, in-app inbox, email and signed webhook adapters (NOT CONNECTED when unconfigured), thresholds and preferences.
- PRIORITY: P2

### 10. Command palette
- STATUS: NOT IMPLEMENTED
- FIX REQUIRED: Ctrl or Cmd+K palette with navigation, entity search route and agent hand-off.
- PRIORITY: P3

### 11. Mobile layouts
- STATUS: PARTIALLY WORKING
- EVIDENCE: tables scroll horizontally; only the products list has cards; content and distribution boards need 64 to 72 rem; content approval decision panel below the preview on phones.
- FIX REQUIRED: responsive card pattern for knowledge, content approval, queries, AI visibility; list view of boards on phones; decision panel first on mobile.
- PRIORITY: P2

### 12. Website crawler
- STATUS: PARTIALLY WORKING (SECURITY RISK)
- EVIDENCE: `core/seo/crawl.ts` BFS with 500-page cap; robots checked for `Googlebot` while the user agent is `NovarysBeacon/1.0`; robots 5xx treated as allow-all; crawl-delay ignored; blocked URLs not recorded; `services/seo.ts:12-14` accepts any start URL; SSRF guard solid (`lib/security/ssrf.ts`) but misses 6to4 and Teredo, and uses an idle timeout rather than a hard deadline; H1, robots directives, hreflang, external links, redirects, OpenGraph, images and content hash not persisted; no diff between crawls; stale-job recovery can run a long crawl twice.
- FIX REQUIRED: robots for Beacon's token with `*` fallback, 5xx disallow, crawl-delay, blocked URLs recorded; verified domains; per-organisation audit rate limit; full page facts and content hash; audit-to-audit change detection with carried issue status; gzip sitemaps; hard deadline; job heartbeat.
- PRIORITY: P0, P1

### 13. Technical SEO auditor
- STATUS: PARTIALLY WORKING
- EVIDENCE: about 60 percent of the required detections exist (`core/seo/analyze.ts`); missing duplicate content, canonical conflicts beyond cross-domain, important-page noindex, structured data required properties, hreflang reciprocity, robots versus sitemap conflicts, links to redirects; redirected pages stored under the final URL so redirecting sitemap entries and links are never matched; issues lack why, how to fix and auto-fixable.
- FIX REQUIRED: rule catalogue (what, why, how to fix, auto-fixable, severity), redirect map, missing detections, issue text rendered from the catalogue (fixes translation of dynamic messages).
- PRIORITY: P1

### 14. Query universe
- STATUS: PARTIALLY WORKING
- EVIDENCE: knowledge-graph templates only; `SEARCH_CONSOLE` source never written; 7 intents, no branded flag or topic types; clusters are template names; coverage only against Beacon's own pages; `queries_uq` lacks `product_id` so queries for a second product are silently dropped; N+1 inserts.
- FIX REQUIRED: import GSC queries; branded flag and topic type; coverage against the crawled site and GSC pages; unique index with product; batched inserts.
- PRIORITY: P0 (uniqueness), P1

### 15. Content gap engine
- STATUS: PARTIALLY WORKING
- EVIDENCE: gaps are `CONTENT_GAP` opportunities for ACTIVE queries with coverage NONE; no volume invented; depends on the flawed coverage.
- FIX REQUIRED: gap engine combining GSC demand without a ranking page, AI prompts where competitors are cited, crawled-site coverage and clusters without a pillar page, each gap with its sources.
- PRIORITY: P1

### 16. GEO / AEO knowledge layer
- STATUS: WORKING (provenance gap)
- EVIDENCE: entity profile and answer blocks (`core/geo/entity.ts`), verified-only public endpoint, llms.txt, JSON-LD; unsourced facts cite the product homepage (`entity.ts:36-41, 66-67`); FAQs only from human entries; llms.txt and sitemap routes not rate limited.
- FIX REQUIRED: no homepage substitution (`sourced: false`), FAQ suggestions from queries and prompts as drafts, rate limits.
- PRIORITY: P1

### 17. AI visibility lab
- STATUS: PARTIALLY WORKING
- EVIDENCE: per test stores provider, configured model, response, products and competitors mentioned, citations, own-domain flag, label SAMPLED_OBSERVATION; mention context is the prompt, not the snippet; prompt text not snapshotted; served model and web-search mode not stored; Anthropic and OpenAI return no citations; product trend not filtered by product (`services/ai-visibility.ts:69-70`); `#position` badges read like rankings.
- FIX REQUIRED: prompt snapshot, served model, grounding flag, mention snippets, competitor aliases, citations from web-search-enabled providers, trend fix, "observed in X of Y samples" phrasing.
- PRIORITY: P0 (trend), P1

### 18. Citation analysis
- STATUS: NOT IMPLEMENTED
- FIX REQUIRED: `ai_citations` table (URL, host, kind own, competitor or third party), domain aggregation service and panel, CITATION opportunities.
- PRIORITY: P1

### 19. Competitor intelligence
- STATUS: PARTIALLY WORKING
- EVIDENCE: competitor list, sourced comparison facts, mentions in AI tests; nothing else.
- FIX REQUIRED: competitor share of samples and citations, aliases, optional low-budget robots-compliant competitor crawl, pricing-page change watch with human review.
- PRIORITY: P2

### 20. Opportunity engine
- STATUS: PARTIALLY WORKING (BROKEN inputs)
- EVIDENCE: types CONTENT_GAP, STRIKING_DISTANCE, LOW_CTR, AI_VISIBILITY_GAP, TECHNICAL, ENTITY_COMPLETENESS, COMPARISON_FACTS, INTERNAL_LINKING, CONVERSION, VISIBILITY_DROP; priority formula shown; factor values are unexplained constants; missing CITATION, DISTRIBUTION, CROSS_SELL, REFERRAL; inflated GSC inputs (P0 above); auto-close marks vanished opportunities DONE.
- FIX REQUIRED: latest-snapshot or daily GSC rows with weighted position; missing types; per-factor rationale stored and shown; OBSOLETE instead of DONE with reopening.
- PRIORITY: P0, P1

### 21. Internal linking engine
- STATUS: NOT IMPLEMENTED
- EVIDENCE: only orphan and broken-link rules and inlink counts; hosted pages render no related links.
- FIX REQUIRED: link edge table with anchors, click depth, suggestions, related links on hosted pages, structured graph view.
- PRIORITY: P2

### 22. Sitemap control center
- STATUS: PARTIALLY WORKING
- EVIDENCE: hosted sitemap generated from published pages (deprecated products not filtered, no rate limit); crawled sitemaps checked for missing, invalid, 4xx and non-indexable entries only.
- FIX REQUIRED: sitemap snapshots, redirect, canonical, robots and missing-URL checks, last generated and last verified dates, UI panel.
- PRIORITY: P1

### 23. Google Search Console adapter
- STATUS: PARTIALLY WORKING (BROKEN consumption)
- EVIDENCE: service-account JWT (`integrations/google-auth.ts`), no OAuth; daily totals plus per-query 28-day aggregates (top 1000, no pagination); page dimension stored only as a count; no country or device; no backfill; one integration per product; overlapping snapshots summed by readers; no insight queries.
- FIX REQUIRED: daily query by page by date rows (plus country and device), pagination, 16-month backfill, final data state, page-to-product mapping, search insights (growing, declining, low CTR, positions 4 to 15, new and lost queries and pages), fix readers. OAuth requires a Google Cloud OAuth client: build the flow and leave the client id and secret as the single connection step.
- PRIORITY: P0, P1

### 24. Bing Webmaster and provider abstraction
- STATUS: PARTIALLY WORKING
- EVIDENCE: site totals only; provider lists duplicated in 4 places; adapter field declarations unused; `referring_domains` read but never written.
- FIX REQUIRED: typed normalized rows and capabilities; Bing query and page stats into the same table; UI and scheduler driven by the registry.
- PRIORITY: P1

### 25. GA4 analytics
- STATUS: PARTIALLY WORKING
- EVIDENCE: one report (date, source, medium, sessions); no users, landing pages, campaigns, countries, devices, events or conversions; no journey correlation; GA4 and Beacon AI referrals added together (double count).
- FIX REQUIRED: `analytics_daily` table and multi-report import with pagination; journey service with measured, modelled or unknown labels; side-by-side sources.
- PRIORITY: P1

### 26. Conversion tracking SDK / API
- STATUS: PARTIALLY WORKING (SECURITY RISK)
- EVIDENCE: event types differ from the Phase 2 list (no PRODUCT_VIEWED, SIGNUP_STARTED); no session id; UTM, referrer and landing page not stored on conversions; UTM campaigns never matched; publishable key can write identity and consent (P0); analytics consent not enforced; spoofable IP; replayed events duplicate touches; tracker sends only the first page view.
- FIX REQUIRED: reject identity and consent fields for publishable keys; consent enforcement; Phase 2 event names with aliases; session id, UTM, referrer, landing page and campaign on conversions; idempotency first; trusted proxy IP; SPA tracking and session in the tracker.
- PRIORITY: P0, P1

### 27. Attribution engine
- STATUS: PARTIALLY WORKING
- EVIDENCE: last non-direct and first touch only; rule and touch not persisted; first touch may be missed (200 most recent touches); no touch recorded as DIRECT; no per-conversion view; funnel not cohort based.
- FIX REQUIRED: persist rule and touches, linear and position-based credits, UNATTRIBUTED channel, per-conversion explanation view, cohort funnel.
- PRIORITY: P1

### 28. Stripe revenue ingestion
- STATUS: PARTIALLY WORKING (BROKEN on new API shape)
- EVIDENCE: signature, tolerance and idempotency correct; subscription upsert before dedupe; legacy invoice shape only; cumulative refunds; unmapped events dropped with 200; mixed currencies in tiles.
- FIX REQUIRED: both invoice shapes, ordering guard, per-refund ids, webhook inbox with reprocessing, extra event types, per-currency KPIs.
- PRIORITY: P0, P1

### 29. Integration health
- STATUS: PARTIALLY WORKING
- EVIDENCE: no EXPIRED state; CONNECTED on save without a test; scheduler skips ERROR integrations forever; 401 and 403 retried; no last failure time, scopes or reconnect flow; connection tests run inside a DB transaction; "sync now" re-enables DISABLED.
- FIX REQUIRED: EXPIRED, last success and failure times, scopes; non-retryable auth errors; scheduler retries ERROR with backoff; test before CONNECTED; stale-sync warnings; reconnect.
- PRIORITY: P0, P1

### 30. Background jobs and worker
- STATUS: WORKING (duplicate execution risk)
- EVIDENCE: SKIP LOCKED queue with backoff, dead state, idempotency; stale recovery after 15 minutes without heartbeat and without attempt cap; complete and fail do not check the lock owner; no retention; `metrics.rollup` no-op; no recurring crawl.
- FIX REQUIRED: heartbeat, owner-checked completion, attempt cap on recovery, retention, recurring audit, per-type concurrency caps.
- PRIORITY: P1

### 31. Ecosystem graph and cross-sell
- STATUS: PARTIALLY WORKING (relationship graph NOT IMPLEMENTED)
- EVIDENCE: untyped cross-sell rules; impressions, clicks, conversions and dismissals tracked, revenue self-reported; event route has no scope, rate limit or product check.
- FIX REQUIRED: typed `product_relationships` (COMPLEMENTARY, SAME_AUDIENCE, WORKFLOW_EXTENSION, UPSELL, CROSS_SELL), full-funnel metrics per rule from measured events, hardened route.
- PRIORITY: P1

### 32. Referrals, affiliates and revenue pages
- STATUS: WORKING
- EVIDENCE: all numbers computed from events, per currency; no hardcoded values; UTM campaigns never receive attribution.
- PRIORITY: P2

### 33. Content engine
- STATUS: PARTIALLY WORKING (data integrity risk)
- EVIDENCE: approval enforced server side (`content:approve`, passing checks); generation uses unverified facts; changelog counted as verified; LLM rewrite guard ignores NEEDS_REVIEW and removed TODO lines; LLM call inside a DB transaction; editing a published asset unpublishes it with only `content:write`; meta fields never fact checked.
- FIX REQUIRED: verified-only generation for publishable content, rewrite guard, LLM outside transactions, published version kept until a new approval, approval rights for edits to approved content.
- PRIORITY: P0, P1

### 34. Content fact checker
- STATUS: PARTIALLY WORKING
- EVIDENCE: headings and short sentences skipped; numbers matched as substrings; no pricing interval, currency or freshness checks; unverified facts count as support; binary pass without severity.
- FIX REQUIRED: check headings and meta, risky patterns on every line, boundary number matching against the supporting fact, pricing validator, claim kind and severity blocking approval.
- PRIORITY: P0

### 35. Content quality gate
- STATUS: PARTIALLY WORKING
- EVIDENCE: page gate measures planned facts, not the written body; no filler, repetition, original-information or cross-asset near-duplicate checks; assets without a page skip the gate.
- FIX REQUIRED: body-based quality checks for every content type, stored per version and enforced at approval and publication.
- PRIORITY: P1

### 36. Content repurposing
- STATUS: NOT IMPLEMENTED
- FIX REQUIRED: derivatives from an approved asset (`source_asset_id`), restricted to the source's facts, fact checked, each approved by a human, flagged stale when the source changes.
- PRIORITY: P2

### 37. Distribution intelligence
- STATUS: PARTIALLY WORKING
- EVIDENCE: 7 catalogue venues inserted regardless of fit; no requirements, last action, result, traffic or conversions; state machine only in the UI; approval not scoped or reset; no automated submission (good).
- FIX REQUIRED: missing fields, UTM campaign per target with measured traffic and conversions, server-side transitions, scoped approval, fit-based seeding.
- PRIORITY: P1

### 38. Autopilot loop
- STATUS: PARTIALLY WORKING
- EVIDENCE: observe, analyse, identify and recommend exist (weekly); approval only flips a status; no execution, measurement or learning; recommendations duplicated every run; correlation not scoped by product.
- FIX REQUIRED: link recommendations to opportunities, dedupe, dispatch safe execution on approval (create draft, experiment or audit; never publish), scheduled measurement against a baseline labelled as correlation, feed outcomes back into confidence.
- PRIORITY: P1

### 39. Growth experiments
- STATUS: PARTIALLY WORKING
- EVIDENCE: hypothesis, metric, dates and free-text result only; no control, variant, sample size, counts or statistical test; any transition allowed, not audited.
- FIX REQUIRED: experiment counts and design fields, two-proportion test with minimum sample, winner only when significant, audited transitions.
- PRIORITY: P2

### 40. Beacon agent
- STATUS: WORKING (moderate SECURITY RISK)
- EVIDENCE: role-filtered tools, per-call RLS transactions, owner-scoped conversations, rate limited; unverified facts it adds can reach public content (closed by fix 33); queued rewrites can regress approved assets; tool timeout does not cancel; no history compaction or budget; tool results returned raw to a model with write tools.
- FIX REQUIRED: verified-only content, no regression of approved assets by queued jobs, statement timeouts, history windowing, per-organisation usage budget, untrusted-data framing, crawl restricted to verified domains.
- PRIORITY: P1, P2

### 41. Duplicated and unused code
- STATUS: DUPLICATED, UNUSED
- EVIDENCE: two fact flatteners with different verification semantics; content type list copied 6 times; distribution kinds copied 3 times; unused exports (`DISTRIBUTION_FLOW`, `pagesForProduct`, `queryIdsByNormalized`, `pageCounts`, `classifyIntent`); `metrics.rollup` stub; never-written columns.
- FIX REQUIRED: one `graphFacts`, enums exported from core, delete or wire unused code.
- PRIORITY: P3 (P1 for the fact flattener)

### 42. Sessions and passwords
- STATUS: WORKING
- EVIDENCE: hashed random tokens, server expiry, revocation on password change and member removal; scrypt; login limits; client IP read from the first `X-Forwarded-For` value (spoofable); hard lockout usable to lock any account; fixed 7-day expiry; `getAuthContext` not memoized.
- FIX REQUIRED: trusted proxy IP helper, back-off instead of hard lockout with atomic counters, idle timeout, `__Host-` cookie, memoized auth.
- PRIORITY: P1, P2

### 43. RBAC on server actions
- STATUS: WORKING
- EVIDENCE: every action goes through `act()`; an EDITOR can mark facts VERIFIED (`setVerificationAction`) while product verification needs `content:approve`; member add attaches existing users without consent and reveals account existence.
- FIX REQUIRED: dedicated verification permission; invitation flow; rate limit on password change.
- PRIORITY: P1, P2

### 44. Org scoping of foreign keys from forms
- STATUS: PARTIALLY WORKING
- EVIDENCE: several inserts trust product, source, affiliate or campaign ids from forms without an ownership check (Postgres foreign keys ignore RLS).
- FIX REQUIRED: `assertOwned` helper on every input id; composite foreign keys later.
- PRIORITY: P2

### 45. Job idempotency keys
- STATUS: SECURITY RISK
- EVIDENCE: keys are global (`jobs/queue.ts:27-37`) and built from user-supplied ids, so another tenant can pre-empt a job (denial of service).
- FIX REQUIRED: scope keys by organisation.
- PRIORITY: P2

### 46. RLS coverage and database roles
- STATUS: WORKING (bypass is a convention)
- EVIDENCE: all tenant tables have enabled, forced RLS with a policy, tested; the bypass is a session setting any app SQL could set; `jobs` and `organizations` have no RLS; the app role owns its tables; provisioning skips silently; no runtime superuser check; compose runs as superuser.
- FIX REQUIRED: refuse to start as superuser or BYPASSRLS in production; fail release without provisioning; compose fix; role split (owner, app, system) and removal of the setting-based bypass; RLS on jobs and organizations.
- PRIORITY: P0 (startup check), P1

### 47. Injection, XSS, CSRF, open redirects, SSRF
- STATUS: WORKING
- EVIDENCE: parameterized SQL; escaped Markdown renderer and JSON-LD; Origin checks; safe redirects; SSRF guard with DNS pinning. Gaps: `/\host` accepted as a link, `Origin: null` gives 500 on upload routes, flash text injection, 6to4 and Teredo not blocked.
- PRIORITY: P3

### 48. Secrets, encryption and logging
- STATUS: WORKING
- EVIDENCE: AES-256-GCM with AAD; HMAC API keys shown once; redacting logger; no key id in the envelope (no rotation); Bing key can reach `lastError` through a URL.
- FIX REQUIRED: key ids and rotation command; strip query strings from stored errors.
- PRIORITY: P2

### 49. Environment variables
- STATUS: PARTIALLY WORKING
- EVIDENCE: lazy validation; localhost defaults for `DATABASE_URL` and `BEACON_BASE_URL` even in production; `.env.example` incomplete.
- FIX REQUIRED: strict production validation at boot (database URL, https base URL, setup token), complete `.env.example`.
- PRIORITY: P1

### 50. Rate limiting
- STATUS: PARTIALLY WORKING
- EVIDENCE: limits on login, setup, tracking, public APIs, agent and uploads; none on `/ask`, `/p`, sitemap, llms.txt, cross-sell events and the Stripe webhook; `readJson` reads the whole body before checking size; all IP keys spoofable.
- FIX REQUIRED: limits on the missing routes, streamed body cap, trusted IP.
- PRIORITY: P1

### 51. File uploads and media
- STATUS: WORKING
- EVIDENCE: magic-byte sniffing, size and pixel limits, WebP re-encode without metadata, strict headers; private chat photos visible to the whole organisation; re-encode runs inside a DB transaction.
- FIX REQUIRED: restrict private media to the uploader, re-encode before the transaction, plan object storage.
- PRIORITY: P2

### 52. Security headers
- STATUS: SECURITY RISK
- EVIDENCE: no Content-Security-Policy and no Strict-Transport-Security (`next.config.ts`).
- FIX REQUIRED: nonce-based CSP and HSTS in production.
- PRIORITY: P1

### 53. Public exposure control
- STATUS: UNUSED (SECURITY RISK)
- EVIDENCE: `settings.publicSiteEnabled` declared and never read; every organisation's public endpoints are served by slug; `/api/health` exposes queue counts.
- FIX REQUIRED: honour the setting (404 when off) with an audited toggle; minimal health output.
- PRIORITY: P2

### 54. Tenant isolation tests
- STATUS: PARTIALLY WORKING
- EVIDENCE: product cross-tenant tests and a structural RLS test exist, plus scattered cases; no action-level RBAC matrix; not covered: queries and metrics with a foreign product, revenue, reports, recommendations, commissions, memberships through actions, agent conversations of another user, jobs.
- FIX REQUIRED: parameterized cross-tenant test over every tenant table and an action authorization matrix.
- PRIORITY: P1

### 55. Deployment configuration
- STATUS: PARTIALLY WORKING
- EVIDENCE: multi-stage non-root Dockerfile; no HEALTHCHECK; Railway pre-deploy, health check and worker service configured only in the dashboard; health returns 200 when the worker is stale.
- FIX REQUIRED: `railway.json` for the web service (pre-deploy release, health check, restart policy) and documented worker service, Docker HEALTHCHECK.
- PRIORITY: P1

### 56. Performance
- STATUS: PARTIALLY WORKING
- EVIDENCE: missing indexes (ai_mentions, ai_visibility_tests by organisation and date, attribution and conversion events by identity and referral code, cross-sell events, product child tables by product, opportunities, seo issues and audits, jobs); N+1 on public graphs, `/p` pages, query generation, coverage, opportunities; unbounded list pages; `promptSummaries` loads full responses; jobs and audit logs grow unbounded.
- FIX REQUIRED: index migration, batched loads and inserts, pagination, SQL aggregation, retention.
- PRIORITY: P2

### 57. Dependencies
- STATUS: WORKING
- EVIDENCE: `pnpm audit --prod` reports no known vulnerabilities; not run in CI.
- FIX REQUIRED: run the audit in CI.
- PRIORITY: P3

## Remediation plan

Wave 1 fixes foundations before features: every P0 above, then the P1 items that the Phase 2 features depend on (search data model, measurement states, provenance, crawler data, opportunity inputs, security headers, roles, deployment). Wave 2 builds the Phase 2 capabilities on top (briefing, weekly report, notifications, autopilot loop, experiments, repurposing, ecosystem graph, onboarding v2, score v2, launch mode, command palette, mobile, empty states). Results are recorded in `docs/SECURITY_AUDIT.md` and `docs/PRODUCTION_VALIDATION.md`.

## Status after remediation

Re-audit on 2026-10-01 after Waves 1 and 2 and the follow-up fixes: every FIX REQUIRED item was checked against the code again (files and functions opened, not commit messages). Every P0 item is implemented. The follow-up wave closed: the content creation IDOR (#44, foreign product or query ids now rejected in `createAsset`, covered by the authorization matrix), per-type job concurrency caps in the claim SQL (#30), demo data isolated in `pnpm db:seed:demo` and refused in production (#1), SQL aggregation for AI visibility prompt summaries (#56), product-scoped cross-sell KPIs (#2), registry-driven provider lists (#24, part), the missing launch checklist items (#6), approval handling when an approved draft is edited (#33), signed flash messages (#47), a single list of distribution kinds (#41), the remaining empty states (#3) and a competitor page watch (#19: robots-compliant weekly check of watched pages, factual diffs, human review through notifications, never writing facts).

What remains, by priority:

| # | Item | Priority | Remaining | Needs |
|---|---|---|---|---|
| 46 | Database roles | P1 | The app role still owns the tables and runs migrations; the planned owner/migrator role split is not done. RLS is forced and the app role is refused at boot if it can bypass RLS. | A migration of ownership on the production database, planned as a dedicated change |
| 55 | Deployment as code | P1 | Pre-deploy command, health check and restart policy live in the Railway dashboard (a root `railway.json` would apply to both services). Documented in the README. | Per-service config files and the config path set in the Railway dashboard |
| 24 | Bing backlinks | P1 | The Beacon Score's referring-domains line stays "not measured": no source writes it yet. | A Bing Webmaster API key and its link endpoints |
| 51 | Media storage | P2 | Image bytes are stored in PostgreSQL. | S3-compatible bucket credentials |

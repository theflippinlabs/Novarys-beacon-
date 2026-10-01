# Novarys Beacon: Architecture

> **Build once. Be found everywhere.**
> Beacon is the distribution, discovery and growth infrastructure of the Novarys ecosystem: it understands every product, generates its discovery infrastructure, monitors visibility, finds missing opportunities, turns traffic into users, cross-sells between products and measures the revenue of every acquisition source.

Beacon never fakes visibility, rankings, citations or traffic, and cannot guarantee placement in any third-party AI system. It improves discoverability through high-quality public information, technical SEO, structured data, sourced content and measurable distribution.

---

## 1. Repository audit (starting point)

The repository was **empty** when Beacon was started (no commits, no files). Consequently:

| Area | Finding | Decision |
|---|---|---|
| Framework | none | Next.js 16 (App Router, React 19, Turbopack), TypeScript strict |
| Package manager | none | pnpm 10 |
| Database | none | PostgreSQL 16 + Drizzle ORM (SQL migrations, typed queries) |
| Authentication | none | First-party sessions (scrypt passwords, opaque tokens, hashed at rest) |
| API architecture | none | Server Components + Server Actions for the app; versioned REST (`/api/v1`) for products and the public |
| Deployment config | none | Node server + separate worker process; Dockerfile + docker-compose; any Node host (Railway, Fly, Render, VM) |
| Environment variables | none | Validated with zod in `src/lib/env.ts`; documented in `.env.example` |
| UI components | none | Custom design system (`src/components/ui`) on Tailwind CSS v4 |
| Analytics | none | First-party event tracker + provider adapters (GSC, GA4, Bing) |
| Tests | none | Vitest (unit + DB integration) and Playwright (E2E) |
| Integrations | none | Adapter interfaces; Stripe webhooks; Anthropic/OpenAI/Perplexity providers |
| Security controls | none | See §7 |

**Seed data.** No product facts existed in the repository, so only product **names** are seeded (Novus Live, Operator, NovaLex, Aerys / Iris). Every other field is *unknown* until a human completes onboarding. Example queries and prompts quoted in the Beacon brief are seeded as `CANDIDATE` queries / inactive prompts, labelled “from brief, validate”.

---

## 2. Target architecture

```
                        ┌───────────────────────────── Next.js app (web) ─────────────────────────────┐
 Operators (browser) ──▶│ Server Components (pages)  ·  Server Actions (mutations, RBAC + zod + audit) │
                        │ /api/v1/* (products & public) · /api/webhooks/* · /r/{code} · /beacon.js     │
                        │ /p/{org}/… hosted pages · sitemap.xml · llms.txt · /ask/{org}               │
                        └───────────────┬──────────────────────────────┬──────────────────────────────┘
                                        │ services (src/services)       │ enqueue
                                        ▼                               ▼
                        ┌──────────── core engines (pure, tenant-agnostic, unit-tested) ─────────────┐
                        │ knowledge · discovery · seo · geo · queries · content · opportunities ·    │
                        │ score · attribution · conversions · sales · crosssell · visibility ·        │
                        │ autopilot · command                                                         │
                        └───────────────┬────────────────────────────────────────────────────────────┘
                                        ▼
                        ┌──────────── PostgreSQL 16 (RLS-enforced multi-tenancy) ─────────────────────┐
                        │ tenant tables (organization_id + FORCE RLS) · jobs queue · rate limits      │
                        └───────────────▲────────────────────────────────────────────────────────────┘
                                        │ claim (SKIP LOCKED), retry/backoff, idempotency
                        ┌───────────────┴────────── worker (`pnpm worker`) ───────────────────────────┐
                        │ seo.audit · product.analyze · content.generate · integration.sync ·         │
                        │ ai_visibility.run · opportunities.generate · score.compute ·                │
                        │ autopilot.report · maintenance.cleanup  + recurring scheduler                │
                        └───────────────┬────────────────────────────────────────────────────────────┘
                                        ▼  provider adapters (swappable)
             Google Search Console · GA4 Data API · Bing Webmaster · Stripe · Anthropic · OpenAI · Perplexity
```

### Layering rules

1. **`src/core/*`**: pure functions. No DB, no network, no Novarys-specific assumptions. Everything that decides (classification, scoring, gating, attribution, recommendation) lives here and is unit-tested.
2. **`src/services/*`**: orchestration over a tenant-scoped transaction (`Tx`). They load data, call core engines, persist results and write audit logs.
3. **`src/app/*`**: UI and HTTP. Server Actions use `act()` (`src/lib/actions.ts`): authenticate → authorise (RBAC) → validate (zod) → run inside `withOrg()` → flash + redirect. Route handlers resolve the tenant from a hashed API key or webhook integration id, never from user input.
4. **`src/jobs/*`**: background execution. Long work (crawls, generation, syncs, analyses) never blocks a web request.
5. **`src/integrations/*`, `src/ai/*`**: adapters behind interfaces (`VisibilityAdapter`, `LlmProvider`).

### Source map

| Path | Responsibility |
|---|---|
| `src/db/schema.ts` | Canonical schema (≈45 tables), enums, relations, `TENANT_TABLES` |
| `src/db/migrations/` | `0000_init` (tables, FKs, indexes), `0001_rls` & `0002_memberships_rls` (row-level security) |
| `src/db/index.ts` | Pools, `withOrg(orgId, fn)` (application role, sets `beacon.org_id`), `asSystem(fn)` / `systemDb()` (separate BYPASSRLS system role, see `src/db/roles.ts`), `inSequence` |
| `src/lib/auth/*` | Sessions, RBAC matrix, `requireAuth` / `requirePermission` |
| `src/lib/security/*` | AES-256-GCM, scrypt, HMAC, SSRF-safe fetch, Postgres rate limiter |
| `src/core/knowledge` | Product graph types, loader, completeness, `verifiedOnly`, wizard parsers |
| `src/core/discovery` | URL scheme, page planner, publication quality gate |
| `src/core/seo` | HTML/site analyzers, crawler, robots.txt, sitemaps, Schema.org JSON-LD |
| `src/core/geo` | Entity profile (WHO/WHAT/WHO FOR/PROBLEM/HOW/PROOF/PRICE/DIFFERENTIATION/SOURCES/LAST VERIFIED), answer blocks, llms.txt |
| `src/core/queries` | Intent classifier (explainable), funnel mapping, query-universe expansion |
| `src/core/content` | Fact-grounded draft generator, fact checker, SEO/GEO checks, workflow state machine, safe Markdown |
| `src/core/opportunities` | Evidence-based opportunity rules + priority |
| `src/core/score` | Beacon Score (7 transparent components, “fastest path to N”) |
| `src/core/attribution`, `conversions` | Channel classification, attribution rules, commissions, fraud flags, funnels |
| `src/core/sales`, `crosssell` | Explainable product recommendation; consent-gated, capped cross-sell |
| `src/core/visibility` | AI answer parsing (mentions, positions, citations) |
| `src/core/autopilot`, `command` | Growth analyst; attention prioritisation |

---

## 3. Database model

All tenant-owned tables carry `organization_id` (FK → `organizations`, `ON DELETE CASCADE`) and are listed in `TENANT_TABLES`; an integration test asserts every such table has RLS **enabled and forced**.

| Domain | Tables |
|---|---|
| Tenancy & access | `organizations`, `users` (global identities), `memberships` (role per org), `sessions` (hashed tokens), `api_keys` (HMAC-hashed), `audit_logs`, `rate_limit_buckets` |
| Knowledge graph | `products`, `product_facets` (FEATURE · USE_CASE · AUDIENCE · INDUSTRY · PROBLEM · INTEGRATION · DIFFERENTIATOR), `product_pricing`, `product_faqs`, `product_proofs`, `product_sources`, `product_changelog`, `competitors`, `product_competitors` (sourced comparison facts) |
| Discovery | `query_clusters`, `queries`, `pages`, `content_assets`, `content_versions` |
| SEO | `seo_audits`, `seo_issues`, `crawled_pages` |
| Visibility | `visibility_metrics` (daily series per provider/metric/dimension), `ai_visibility_prompts`, `ai_visibility_tests`, `ai_mentions` |
| Intelligence | `opportunities` (fingerprint-idempotent), `growth_reports`, `recommendations`, `experiments`, `ai_runs` (provenance), `beacon_scores` |
| Distribution | `campaigns`, `distribution_targets` |
| Novarys ID | `identities` (external ref, keyed email hash, consent, acquisition), `identity_products` (status, plan, *explicitly shared* traits) |
| Referrals & revenue | `affiliates`, `referral_codes`, `attribution_events` (touches), `conversion_events`, `subscriptions`, `revenue_events`, `commissions` |
| Ecosystem | `cross_sell_rules`, `cross_sell_events` |
| Integrations | `integrations` (non-secret config), `provider_credentials` (AES-256-GCM envelope, AAD = integration id) |
| Jobs | `jobs` (system queue on the system role; RLS: a tenant scope sees only its own jobs, system jobs are invisible) |

**Design notes**

- *Facets* normalise the repeated “named list” parts of the graph into one table discriminated by `kind`, with per-item `verification` and `source_id`.
- *Unknown is first-class*: nullable booleans (`api_available`, `free_trial`), nullable prices (“not public”), and `verification ∈ {UNVERIFIED, NEEDS_REVIEW, VERIFIED, REJECTED}`. Editing a verified fact downgrades it to `NEEDS_REVIEW`.
- Money is stored in minor units (`bigint`) with an ISO currency; aggregates group by currency and never sum across currencies.
- Idempotency keys: `jobs.idempotency_key`, `conversion_events (org, idempotency_key)`, `revenue_events (org, provider, external_id)`, `opportunities (org, fingerprint)`, `commissions (affiliate, revenue_event)`.
- Indexes cover tenant + status/time access paths (e.g. `conversion_events (org, type, occurred_at)`, `jobs (status, run_at)`).

---

## 4. Engines

### A. Product knowledge graph (single source of truth)
Onboarding v2 (`core/onboarding/steps.ts`, `/products/new` then the product's onboarding page): ADD PRODUCT → WEBSITE → PRODUCT INFORMATION (identity, audience, features, pricing, competitors, proof sub-steps) → VERIFY KNOWLEDGE → CONNECT SEARCH DATA → CONNECT ANALYTICS → INITIAL CRAWL → QUERY UNIVERSE → CONTENT GAPS → OPPORTUNITIES → BEACON SCORE. Each step is stored in `products.onboarding_steps` as done, skipped or pending; a skipped step is never shown as done. Website extraction (`core/onboarding/extract.ts`, `services/extraction.ts`) crawls the homepage and up to four key pages of a **verified** domain with the SSRF-safe fetcher (no transaction open), and proposes only values literally present in the pages (text, links, JSON-LD), each tied to its URL; a human accepts a proposal into the graph, where it stays UNVERIFIED until someone with `fact:verify` verifies it. Onboarding writes only to the graph. `computeCompleteness` reports six sections (identity 30, features 20, pricing 15, use cases 10, proof 10, documentation 15) with earned/max per item; verified facts count fully, unverified half, outdated or conflicting zero. Public surfaces use `verifiedOnly(graph)`, which checks each scalar field's own claim (`product_claims`).

**Provenance.** Facets, pricing, FAQs, proofs, changelog entries and scalar claims carry `verification` (UNVERIFIED, NEEDS_REVIEW, VERIFIED, REJECTED, OUTDATED, CONFLICTING), `verified_at`, `verified_by` and a derived `confidence` (`core/knowledge/confidence.ts`: status x source x age). Verifying requires the `fact:verify` permission and a source; any edit of a verified value sends it back to NEEDS_REVIEW (`services/provenance.ts`). The weekly `sources.check` job checks source URLs (HEAD then GET, SSRF-safe, outside transactions) and marks facts OUTDATED (source failing twice, or verified longer ago than the organisation's `knowledge.staleAfterDays`, default 180) or CONFLICTING (two sources disagree on a scalar claim or a plan's price, currency or interval). Prices, currencies and billing intervals are never defaulted.

### B. Discovery engine
`planPages` derives the page set (`/{product}`, `/{product}/features/{f}`, `/use-cases/`, `/industries/`, `/for/`, `/integrations/`, `/compare/`, `/alternatives/`, `/answers/`, `/changelog/`) **only when the graph holds enough material** (e.g. facet description ≥ 60 chars; comparisons need ≥ 3 sourced facts) and reports skipped pages with the reason. `assessPage` scores information completeness, factual confidence (verification × sourcing), intent match, duplicate similarity (word-shingle Jaccard) and usefulness. Pages failing any threshold cannot be published.

### C. SEO engine
SSRF-safe crawler (robots.txt aware, sitemap/sitemap-index discovery, page budget). Page rules: status, redirects, title/description, H1/hierarchy, canonical, robots/noindex, OpenGraph/Twitter, viewport, `lang`, image alt/dimensions, empty links, hreflang, JSON-LD validity, mixed content, thin/stale content, server-response and weight *signals* (explicitly not Core Web Vitals). Site rules: duplicate titles/descriptions, orphans, broken internal links, sitemap hygiene, missing entity schema. JSON-LD generators (`SoftwareApplication`/`WebApplication`, `Organization`, `Offer` (verified prices only), `FAQPage`, `Article`, `BreadcrumbList`, `HowTo` (only with ≥ 2 real steps)). Sitemaps and sitemap indexes are generated for published pages.

**Crawl intelligence (Phase 2).** robots.txt is evaluated for Beacon's own token `NovarysBeacon` (falling back to `*`); a 4xx robots.txt means allow all, a 5xx / 429 / unreachable one stops the audit (whole site disallowed); `Crawl-delay` is honoured (default 200 ms, capped at 10 s) and blocked URLs are recorded as INFO facts. Every request has a hard deadline; gzip sitemaps (50 MB decompressed cap) and sitemap indexes two levels deep are read and snapshotted (`sitemap_snapshots`). Pages are stored with their full facts (status, final URL, redirect chain, robots meta, X-Robots-Tag, headings, JSON-LD validation, hreflang, OpenGraph/Twitter, images, indexability reason, content hash, click depth) and link edges with anchors in `crawl_links`; redirects are kept as their own rows so redirecting links and sitemap entries are matched. Issues come from the rule catalogue (`core/seo/rules.ts`: severity, what, why, how to fix, auto-fixable) and carry a fingerprint (product, rule, URL); each audit stores a diff against the previous one and IGNORED/RESOLVED decisions carry forward. **Domain authorisation:** audits only crawl hosts covered by a domain the organisation verified (`verified_domains`, DNS TXT `beacon-verification=<token>` or `/.well-known/beacon-verification.txt`), at most 10 audits per hour per organisation and one active audit per product; the worker schedules a weekly audit per product with a verified domain. Development-only bypass: with `BEACON_SSRF_ALLOW_PRIVATE=true` and `NODE_ENV` not production, localhost and private-IP hosts (the E2E fixture) skip verification.

### D. GEO / AEO engine
Machine-readable entity profile per product with sourced claims, `unknowns` and `lastVerified`, published at `/api/v1/entity/{org}/{product}` (verified facts only). Answer blocks (“What is X?”, “Who is X for?”, “How much does X cost?”, “Does X support/integrate …?”, “Alternatives to …?”, FAQs) each cite their sources; questions without facts are returned as gaps. `llms.txt` per organisation.

### E. Query intelligence
Rule-based, explainable intent classifier (INFORMATIONAL, COMMERCIAL, TRANSACTIONAL, NAVIGATIONAL, COMPARISON, PROBLEM, ALTERNATIVE) with confidence and funnel stage; brand-aware. Query universe expansion combines category/keywords with audiences, industries, problems, features, integrations and competitors, de-duplicated by token set and capped; results are `CANDIDATE`s for human curation; long-tail variations are tracked, never mass-produced into pages. Queries are unique per product (`queries_uq` includes `product_id`) and carry a `branded` flag and a `topic_type` (FEATURE, INDUSTRY, AUDIENCE, USE_CASE, INTEGRATION, CATEGORY, BRAND, COMPETITOR, PROBLEM) from generation provenance or the explainable classifier (no LLM refinement; low-confidence results are flagged for review). After each search sync, measured queries above an impressions threshold are imported as `SEARCH_CONSOLE` candidates. `core/queries/cluster.ts` groups queries deterministically (Jaccard on lemmatised topic terms or two shared head terms, separate comparison and branded families) into `query_clusters` with a dominant intent and ONE recommended asset each. Coverage (`core/queries/coverage.ts`) is computed against Beacon's own pages, the product's latest crawl (title, H1, headings, URL) and search query x page pairs, storing `covered_by_url` and the reason per query and per cluster. The content gap engine (`core/content/gaps.ts`) derives one gap per cluster (demand without a ranking page, relevant and not covered, AI answers naming competitors only, no pillar page) with coverage evidence, relevance, recommended and supporting assets, sources and search demand (or UNKNOWN).

### F. Visibility monitor
Provider adapters (`VisibilityAdapter`, registry-driven): Google Search Console (Search Analytics API; OAuth 2.0 "Connect with Google" with `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`, or a service-account JWT), GA4 Data API (sessions by channel incl. AI-assistant referrers), Bing Webmaster (rank & traffic, query and page stats). Search adapters return normalized `SearchRow`s stored in `search_daily` (one row per integration, day and grain: total, query, page, query x page, country, device; upserted on a NULLS NOT DISTINCT key, so overlapping syncs never double count). First connection queues `search.backfill` (Search Console: 16 months in calendar-month chunks); daily syncs re-pull the last 5 days. `services/search-insights.ts` reads one grain at a time (growing/declining/new/lost queries and pages, low CTR against the organisation's own median CTR per position bucket, positions 4 to 15, `latestQueryMetrics`). Integration health: 401/403 mark an integration EXPIRED (not retried), 429/5xx are retryable ERRORs re-scheduled with back-off, saving runs a connection test outside any transaction. First-party events add visitors, CTA clicks and AI referrals (chatgpt.com, perplexity.ai, claude.ai, gemini, copilot, …). Metrics land in `visibility_metrics`; unconnected sources render as **Not connected**, never zero.

### G. AI visibility tests
Tracked prompts are sent to configured providers through official APIs; responses are parsed objectively (entities mentioned, order of first appearance, citations, own-domain citations) and stored as `SAMPLED_OBSERVATION`s with weekly trends. Each test keeps the prompt text sent, the configured and served model, the web-search (grounded) flag, request parameters and locale; each mention keeps its offset and a ~200-character snippet; competitors have editable aliases. Anthropic tests use the server-side `web_search_20260209` tool (`BEACON_ANTHROPIC_WEB_SEARCH`, default on; falls back to an ungrounded sample if the key cannot use web search); Perplexity and OpenAI search models return citations with offsets. Every citation is classified into `ai_citations` (host, registrable domain, OWN / COMPETITOR / THIRD_PARTY, documented host-pattern category, entities mentioned nearby; `core/visibility/citations.ts`), aggregated as "cited in X of Y sampled responses" per domain and per competitor. The UI says "observed in X of Y sampled responses" and "order of appearance", never rankings, and states that samples do not represent every user’s AI response.

### H. Opportunity engine
Rules over measured evidence: content gaps, striking distance (positions 8 to 20), low CTR, AI-visibility gaps (competitors mentioned, product absent), critical/high technical issues, entity completeness, missing comparison facts, orphan pages, low-converting pages, visibility drops. Each opportunity carries evidence, competitors, ordered actions, impact/confidence/effort/urgency and `priority = impact × confidence × urgency ÷ effort`; potential is LOW/MEDIUM/HIGH only. Phase 2 adds a `category` taxonomy (CONTENT, QUERY, AI_VISIBILITY, CITATION, TECHNICAL, PRODUCT_KNOWLEDGE, DISTRIBUTION, CROSS_SELL, REFERRAL, CONVERSION), cluster-level content gaps, CITATION (frequently cited sources not associated with the product; never automated outreach), DISTRIBUTION, CROSS_SELL and REFERRAL rules, a stored rationale per factor (`scoring_rationale`), a linked `next_action` and `sources`. Query evidence comes from `search_daily` via `latestQueryMetrics` (daily rows, impressions-weighted position; legacy `visibility_metrics` snapshots are read latest-only, never summed). Regeneration is one batched upsert, idempotent and preserves human decisions; vanished conditions become OBSOLETE and reopen when their fingerprint recurs.

### I. AI content studio
`IDEA → GENERATED → FACT CHECK → SEO/GEO CHECK → HUMAN APPROVAL → APPROVED → PUBLISHED → performance`. The deterministic generator composes every sentence from **VERIFIED** graph facts only (`publishableGraph`, with `factRefs`) for 13 formats (`CONTENT_TYPES` in `core/content/types.ts`); missing material becomes `> TODO(editor):` markers that block approval. One fact flattener, `graphFacts(g, { verifiedOnly })` (`core/knowledge/facts.ts`), feeds the fact checker, the LLM prompt and the page planner; every fact carries its verification status (UNVERIFIED, NEEDS_REVIEW, OUTDATED and CONFLICTING all count as not verified).

- **Fact checker** (`core/content/fact-check.ts`): checks every body line, heading, meta title and meta description. Each claim gets a status (SUPPORTED, NEEDS_REVIEW, UNSUPPORTED, WRONG_PRICING, OUTDATED_PRICING), a kind (fact, pricing, statistic, customer, testimonial, award, rating, superlative, integration, competitor) and a severity: HIGH blocks approval and publication (server side), MEDIUM needs an explicit acknowledgment by the approver, LOW is informational. Numbers match on token boundaries against the supporting fact; prices must match a VERIFIED plan's amount, currency, interval and trial, and a plan verified longer ago than the organisation's `knowledge.staleAfterDays` is OUTDATED_PRICING.
- **Quality gate** (`core/content/quality.ts`): measured on the actual body for every format (near-duplicate shingle similarity against the organisation's current and published versions, keyword stuffing, generic filler in English and French, repeated 4-grams, unsupported-claim ratio, intent fit of the target query, unique verified facts per 100 words); stored in `content_versions.quality_check`, enforced at approval and publication.
- **LLM rewrite** (`ai/tasks.ts` `rewriteDraft`): the `content.generate` job reads in one transaction, calls the LLM with no transaction open, and persists in a second one. `guardRewrite` keeps the rewrite only if it keeps every TODO line, Sources URL and `{cta:}` marker, adds no unsupported claim and does not raise the NEEDS_REVIEW, UNSUPPORTED or HIGH counts. A queued job never overwrites an asset approved, published or edited since it was requested (it aborts with a note in the audit log).
- **Versions**: `content_assets.approved_version_id` and `published_version_id`. The hosted site serves the published version while newer drafts are edited or regenerated; publishing a newer version needs a new approval. Optional org policy `settings.content.requireDistinctApprover` (Settings) refuses approval by a version's author.
- **Repurposing** (`repurposeAsset`, UI on `/content/[id]`, agent tool `repurpose_content`): from APPROVED or PUBLISHED assets only, derivative drafts (X, LinkedIn, TikTok, short video, newsletter block, FAQ additions, product update) restricted to the source version's facts, fact checked against the graph and the source body, each approved by a human; `source_stale_at` flags them when the source publishes a newer version.

Only `content:approve` holders approve/publish.

### J. Distribution center
Targets by kind (directories, launch platforms, communities, social, newsletters, partners, affiliates, influencers, agencies, media, backlinks) with the DISCOVERED → QUALIFIED → PREPARED → SUBMITTED → PUBLISHED → PERFORMING flow (+ FOLLOW_UP, REJECTED). `SUBMITTED`/`PUBLISHED`/`PERFORMING` require a recorded approval; Beacon never auto-submits to third parties.

### K. AI sales agent
`recommendProducts` scores products against a stated need using weighted fact matches (audiences/problems > use cases/industries/category > features/integrations), explains every match, includes verified pricing and CTA, and returns *no recommendation* below the threshold. Ownership never boosts a score. Public endpoint `/api/v1/recommend` and page `/ask/{org}` use verified facts only.

### L. Cross-sell engine
Rules (source → destination, required shared traits, minimum tenure, source status), message, CTA, per-rule frequency cap, lifetime cap, global daily cap per identity. Requires explicit `crossProduct` consent; never targets users already on the destination; dismissals and conversions suppress. Impressions/clicks/conversions/revenue are tracked per rule.

### M. Novarys ID (architecture + foundation)
One `identity` per person per organisation keyed by an external reference supplied by the identity provider or product (`/api/v1/identify`). Stored: keyed email hash (never the raw email), consent (analytics, marketing, crossProduct), acquisition, products used with plan/status, and only the traits a product **explicitly** shares. Product data stays in the product. Future: a central Novarys IdP (OIDC) issuing the `external_ref`, single sign-on across products, and consent management UI; the schema already supports it.

### N. Referral / affiliate engine
Referral links `/r/{CODE}` (destination restricted to the product’s https domain), affiliates with commission rate, duration and hold period, campaigns with UTMs, VISIT → SIGNUP → ACTIVATION → PURCHASE → RECURRING REVENUE tracking, commissions with PENDING/APPROVED/PAID/VOID/ON_HOLD and fraud flags (self-referral, instant conversion, IP velocity, refunds).

**Attribution rules (explicit, per organisation):** touches within a lookback window (default 30 days); referral/affiliate touches take precedence (configurable); otherwise LAST non-direct touch (default) or FIRST touch; no touch → DIRECT. Revenue is attributed at the identity’s first conversion into the product so renewals keep their original channel. Channel classification order is documented in `classifyChannel`.

### O. Conversion engine
Tracker `beacon.js` (first-party cookie, honours DNT/GPC, no fingerprinting) sends `PAGE_VIEW`/`CTA_CLICK` with publishable keys from allowed origins; lifecycle events (`SIGNUP`, `TRIAL_STARTED`, `ACTIVATED`, `CHECKOUT_STARTED`, `SUBSCRIBED`, `UPGRADED`, `CANCELLED`) require secret server keys. Funnels by product and channel; rates are `null` (shown “n/a”) without a denominator.

### P. Growth autopilot
Weekly (and on-demand) deterministic analyst: *what happened* (period-over-period metrics with sources), *why it may have happened* (coinciding events, labelled CORRELATION or INSUFFICIENT_DATA, never causation), opportunities, recommended actions (approval required for production content, external accounts, paid campaigns), content to create, technical issues, experiments and signals to monitor, plus data-coverage gaps.

**Autopilot loop** (`services/autopilot.ts`): OBSERVE → ANALYZE → IDENTIFY → RECOMMEND (deduped proposals) → (human) APPROVE → EXECUTE → MEASURE → LEARN. Every proposal waits for a human decision; EXECUTE only performs in-app work (drafts, recommendations), never external publication or submission. MEASURE compares the tracked metric before and after; LEARN adds the measured outcome to a per-opportunity-type tally (`autopilot_learning`) that adjusts future opportunity scores transparently. **Experiments** (`services/experiments.ts`, `core/experiments`): a design with arms, a counted event and a minimum sample size per arm; counts come from tracked events tagged with the experiment and variant, or are entered manually and labelled so; no winner is declared until the sample size is reached and the result is significant.

**Launch mode** (`services/launch.ts`, `/products/[slug]/launch`): a checklist derived from real state (knowledge completeness and verification thresholds, connections; an item whose source is missing shows NOT_CONNECTED), PRE_LAUNCH with an optional date, "Launch product" refused while blocking items are open unless the person explicitly launches anyway, a query baseline captured before launch and a post-launch monitoring panel showing deltas against it.

### Q. Beacon Score
0 to 100 over seven dimensions: Technical discovery 20, Content coverage 20, Entity completeness 15 (verification-weighted), Authority / citation signals 15, Query coverage 15, Conversion readiness 10, Measurement readiness 5. Every line shows earned/max, the reason and whether it is `measurable`; lines that cannot be measured (backlink source or AI provider not connected) or do not apply (no comparison planned) are excluded and the score is rescaled (`total = 100 x earned / measurable max`), with the measured coverage and "Not measured: connect X" shown. AI mentions are a rate over this product's own prompts. The stored score (with a per-line diff against the previous computation) is what the product overview and the command center show; "Fastest path to N" ranks fixes by points per effort. It measures readiness, not rankings.

### R. Daily command center
“What needs my attention today?”: critical SEO problems, products losing organic visibility, high-potential opportunities, drafts ready for approval / blocked, pending external submissions, recommendations, experiments ready, referral conversions, commissions on hold, failing integrations, dead jobs, incomplete onboarding, ranked by impact × confidence × urgency ÷ effort. KPI groups (discovery, acquisition, revenue, ecosystem, content) compare equal-length periods.

**Briefings, reports and notifications.** The daily briefing (`services/briefings.ts`, deterministic, no LLM) snapshots measured metrics, compares them with the previous stored briefing and ranks the top 5 actions, each linking to the exact page; unconnected sources show "Not connected". The weekly report (`services/reports.ts`) covers the last complete week against the week before, organisation first then one scope per product, and exports as CSV, Markdown or JSON (`/api/reports/[id]/export`). Notifications (`services/notifications.ts`, bell in the header) evaluate thresholds per organisation with a dedupe window; channels are in-app, email (through the email adapter when `RESEND_API_KEY` is set) and signed webhooks (https, public addresses only, secret encrypted at rest, delivered by the job queue with back-off). Integration health is shown at `/settings/health`.

---

## 5. Background jobs

Postgres-backed queue (`src/jobs/queue.ts`):

- **Claiming:** `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`: safe with many workers.
- **Retry & backoff:** exponential with jitter (30 s → 1 h cap), `max_attempts` (default 5), `NonRetryableError` → `DEAD` immediately.
- **Idempotency:** unique `idempotency_key`; recurring work uses period-scoped keys (`sync:{integration}:{day}`, `autopilot:{org}:{week}`).
- **Recovery:** stale `RUNNING` jobs (worker died) return to the queue after 15 minutes.
- **State & errors:** status, attempts, last error, result, timings; visible and retryable in *Settings → System health*.
- **Scheduler:** every 5 minutes the worker enqueues daily integration syncs, opportunity generation, score computation, cleanup, weekly growth reports and AI-visibility runs (only when prompts and a provider exist).
- **Deployment:** `pnpm worker` (separate process, recommended) or `BEACON_EMBEDDED_WORKER=true` (single container).

Network I/O (crawls, provider APIs, LLM calls) happens **outside** long database transactions.

---

## 6. AI architecture

- `LlmProvider` interface (`src/ai/types.ts`): `answer()` for sampled visibility tests, optional `generateObject()` for schema-constrained output (zod).
- Providers: Anthropic (official SDK, default model `claude-opus-5-5`, structured outputs, server-side refusal fallbacks enabled), OpenAI-compatible (OpenAI, Perplexity with citations).
- Resolution: organisation credentials (encrypted, Settings → Integrations) take precedence over deployment environment keys.
- Task layer (`src/ai/tasks.ts`): `generateContent()`, `factCheckDraft()`, `classifyIntent()`, `analyzeVisibility()`, `generateOpportunity()`, `recommendProduct()`. Each has a deterministic implementation so Beacon is fully functional without any LLM.
- Provenance: every important output is recorded in `ai_runs` with task, provider, model, prompt/rule version (`PROMPT_VERSIONS`), input hash, output, confidence, sources, latency and status; content versions link to their run; humans review before publication.

---

## 7. Security model

| Control | Implementation |
|---|---|
| Server-side secrets only | No `NEXT_PUBLIC_*` secrets; env validated eagerly at boot (instrumentation, worker); production refuses to start without `DATABASE_URL`, an https `BEACON_BASE_URL`, encryption/hash keys, system-role credentials, or with the SSRF escape hatch on |
| Encrypted credentials | AES-256-GCM with per-integration AAD; envelope v2 carries a key id (`BEACON_ENCRYPTION_KEYS` ring, legacy key = `v1`), `pnpm secrets:rotate` re-encrypts; plaintext never returned to the browser or logged; stored provider errors pass through `redactErrorText` |
| Authentication | scrypt (N=2¹⁵) passwords, ≥ 12 chars; opaque 256-bit session tokens stored as SHA-256; sessions end after 24 h without use (sliding, renewed at most hourly) or 30 days after sign-in (`core/auth/session-policy.ts`); `__Host-beacon_session` cookie in production (httpOnly, SameSite=Lax, Secure, Path=/; the legacy `beacon_session` is read and migrated once by the proxy); members join through invitations (`invitations`, token hash only, 7 days, `/invite/[token]`: the invitee sets their own password or signs in, identical answers whether or not the email has an account; emailed through the email adapter when configured, else a copyable link for the admin); password changes rate limited per user; login rate limits (IP + email) and exponential back-off per (email, IP) with atomic counters (no account lockout); constant-ish time and identical throttling for unknown users; client IP from `clientIp()` honouring `BEACON_TRUSTED_PROXY_HOPS`; `getAuthContext` memoized per request |
| RBAC | OWNER / ADMIN / EDITOR / ANALYST / VIEWER permission matrix enforced in every Server Action and API; members cannot grant roles ≥ their own; removing a member revokes their sessions |
| Tenant isolation | `organization_id` everywhere + Postgres **FORCE ROW LEVEL SECURITY** (fails closed), also on `jobs` and `organizations`; app also filters by org explicitly and checks form ids with `assertOwned`; the app role is NOSUPERUSER NOBYPASSRLS (checked at boot) and only the separate system role bypasses RLS (no session-setting bypass); every tenant table is covered by `tests/integration/tenant-isolation.test.ts` |
| Audit logging | Append-only `audit_logs` with redacted metadata for security- and content-relevant actions |
| Rate limiting | Postgres fixed-window buckets (multi-instance safe) on login, setup, ingestion, public endpoints (`/ask`, `/p`, sitemap, llms.txt, entity, published), cross-sell events, the Stripe webhook, referral visits; JSON bodies capped by Content-Length and a streamed read |
| Input validation & output encoding | zod on every action/API; React escaping; Markdown renderer escapes first and whitelists `http(s)`/relative links; JSON-LD serialised with `<`/`>`/`&` escaped |
| CSRF | Server Actions’ built-in Origin/Host check; cookie-authenticated route handlers use `sameOrigin()` (`Origin: null` refused with 403); public APIs use API keys (no ambient credentials) |
| SSRF | Crawler: http(s) only, default ports, no credentials in URLs, DNS resolution validated **inside the socket lookup** (no rebinding), private/loopback/link-local/CGNAT/metadata, NAT64, 6to4 and Teredo ranges blocked, per-hop redirect re-validation, size cap and a hard per-request deadline |
| Webhooks | Stripe signature (HMAC-SHA256, constant-time compare, 5-minute tolerance) with encrypted per-integration secret; idempotent by event id |
| API keys | Prefixed, HMAC-hashed at rest, shown once via a short-lived path-scoped httpOnly cookie; publishable keys restricted to origins and PAGE_VIEW/CTA_CLICK |
| Open redirects | Referral and cross-sell destinations must be https on the product’s domain; `_back` redirects must be same-site relative paths |
| Privacy | Raw emails and IPs never stored (keyed HMACs); tracker honours DNT/GPC; cross-sell requires explicit consent |
| Headers | Per-request nonce Content-Security-Policy on documents (`src/proxy.ts`, `src/lib/csp.ts`), HSTS in production, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `COOP`; `poweredByHeader` off |
| Dependencies | `pnpm audit --prod` in CI; Dependabot configuration |
| Logging | Structured JSON with key- and value-based redaction (passwords, tokens, API keys, cookies, ciphertext) |

---

## 8. Integration architecture

| Provider | Interface | Auth | Data |
|---|---|---|---|
| Google Search Console | `VisibilityAdapter` | Service-account JWT (RS256) | daily impressions/clicks/position; per-query & per-page aggregates |
| Google Analytics 4 | `VisibilityAdapter` | Service-account JWT | sessions by channel, AI-assistant referrals |
| Bing Webmaster | `VisibilityAdapter` | API key | daily impressions/clicks |
| Stripe | webhook receiver | signing secret | invoices, subscription changes, refunds → revenue events |
| Anthropic / OpenAI / Perplexity | `LlmProvider` | API key | content rewriting (Anthropic), sampled AI visibility |
| Products (any) | REST `/api/v1` | publishable/secret keys | events, identities, revenue, cross-sell decisions |

Adding a provider = implementing the interface and registering it in `src/integrations/registry.ts`; core code is untouched. Only providers with a working implementation are shown in the UI (no fake buttons). No scraping of services in violation of their terms.

---

## 9. Observability

- Structured JSON logs (`src/lib/logger.ts`) with redaction; `reportError()` hook forwards to `BEACON_ERROR_WEBHOOK_URL`.
- `GET /api/health` (liveness/readiness: DB, queue, worker staleness) and `GET /api/health/metrics` (per-instance latency histograms and job metrics, authenticated).
- *Settings → System health*: DB latency & migrations, queue depth/oldest job/dead jobs with retry, integration sync health, job durations by type, API latency (avg/p95/5xx).

---

## 10. Multi-tenancy & commercialisation

Beacon is internal first but tenant-isolated from day one: every relevant entity is organisation-scoped, RLS-enforced, and branding/behaviour (display name, attribution rules, cross-sell caps) is configuration in `organizations.branding/settings`. Core engines contain no Novarys-specific logic; the only Novarys-specific data is the seed script. Standalone SaaS additions later: self-serve signup, billing, per-tenant quotas, SSO.

---

## 11. Implementation phases

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Auth, organisations, RBAC, products, knowledge graph, onboarding, dashboard, database + RLS | ✅ |
| 2. Discovery | Queries & clusters, page inventory & planner, quality gate, SEO audits, sitemaps, structured data, Search Console architecture | ✅ |
| 3. Intelligence | Opportunity engine, AI provider layer, content studio, GEO/AEO layer, AI-visibility tests | ✅ |
| 4. Measurement | Tracker & events, conversions/funnels, attribution, revenue, Stripe | ✅ |
| 5. Distribution | Campaigns, referrals, affiliates, commissions, distribution center | ✅ |
| 6. Autopilot | Growth analyst, recommendations, experiments, cross-sell, sales agent | ✅ |

Each phase was committed separately with typecheck, lint, tests and build passing.

---

## 12. Assumptions & known limitations

- **No product facts in the repository** → products are seeded by name only; all facts must be entered and verified by humans.
- **Search Console/GA4 auth** uses service accounts (simplest secure server-to-server option). An OAuth consent flow can be added behind the same adapter.
- **Backlinks / referring domains** require an SEO data provider; the interface exists, but no provider is bundled, so the score shows “not connected” rather than estimating.
- **Page-speed** findings are server-side signals; Core Web Vitals require a field-data source (e.g. CrUX API), a future adapter.
- **LLM rewriting** is optional; the deterministic generator produces factual but plain prose.
- **In-process API metrics** are per instance; ship logs to a central platform for fleet-wide metrics.
- **Currency**: aggregates are per currency; there is no FX conversion.
- **Hosted pages** (`/p/{org}/…`) set the canonical to the product domain when known; product sites can instead consume `/api/v1/published/{org}/{product}`.

## Beacon agent

An in-app assistant (`/agent`, centre tab on mobile) that answers questions and performs work through tools.

- **Loop** (`src/agent/loop.ts`): Claude (`claude-opus-5-5`, adaptive thinking, effort `medium`, server-side refusal fallbacks) streamed through `POST /api/agent` as NDJSON events. Up to 16 model ↔ tool rounds per user turn.
- **Tools** (`src/agent/tools/*`): read tools and in-app write tools, filtered by the member's role (`toolsForRole`), validated with zod, each run in its own `withOrg` transaction and audited with `via: "agent"`. Human-only steps (approve/publish, verify facts, external submission, payouts, deletion, members, integrations) have no tool; the agent prepares and links to them.
- **History** (`agent_conversations`, `agent_messages`, RLS): the exact API content blocks are stored append-only and replayed unchanged; photos are stored as private media and referenced by id.
- **Hardening**: tool results are framed as untrusted data (`framing.ts`, described in the system prompt); each tool call runs with `SET LOCAL statement_timeout` and a wall-clock deadline that aborts its `AbortSignal` and cancels the running statement (`pg_cancel_backend`); the model receives a window of the last turns plus an appended running summary note (`window.ts`, stored history never edited; photos older than the last two user turns are sent as a placeholder); a per-organisation monthly token budget (`agent_usage`, `BEACON_AGENT_MONTHLY_TOKEN_CAP`, overridable in Settings) stops the agent with a clear message; changing a product's domain or status needs a Confirm/Cancel from the user (`confirm.ts`, HMAC-bound to conversation, tool and input); conversation seqs are allocated under a row lock.
- **Command palette** (`components/shell/command-palette.tsx`, Ctrl/Cmd+K): navigation, entity search through `GET /api/search` (session, RLS, rate limited, capped), commands that call existing server actions (crawl, analysis, weekly report, draft from a cluster) or navigate; human-gated steps are only navigated to; "Ask the agent" opens `/agent?q=` prefilled.
- **Credentials**: the organisation's Anthropic key from Settings → Integrations (encrypted), else `ANTHROPIC_API_KEY`. Without one the agent says so.
- **Voice**: browser dictation (Web Speech API) and optional read-aloud; nothing audio is sent to the server.

## Media

`media` table (RLS) holds uploaded images re-encoded server-side with sharp (auto-orient, ≤2048 px, WebP, EXIF/GPS stripped, decompression-bomb guard). Public media (product photos, logos, content images) is served by unguessable id at `/api/media/[id]`; private media (agent chat photos) only to the member who uploaded it. Uploads are re-encoded with `prepareImage` before any transaction opens, then stored with `insertImage` inside the tenant transaction.

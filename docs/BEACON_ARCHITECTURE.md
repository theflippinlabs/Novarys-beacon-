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
| `src/db/index.ts` | Pool, `withOrg(orgId, fn)` (sets `beacon.org_id`), `asSystem(fn)` (trusted bypass), `inSequence` |
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
| Jobs | `jobs` (system queue; org-scoped by column, not RLS) |

**Design notes**

- *Facets* normalise the repeated “named list” parts of the graph into one table discriminated by `kind`, with per-item `verification` and `source_id`.
- *Unknown is first-class*: nullable booleans (`api_available`, `free_trial`), nullable prices (“not public”), and `verification ∈ {UNVERIFIED, NEEDS_REVIEW, VERIFIED, REJECTED}`. Editing a verified fact downgrades it to `NEEDS_REVIEW`.
- Money is stored in minor units (`bigint`) with an ISO currency; aggregates group by currency and never sum across currencies.
- Idempotency keys: `jobs.idempotency_key`, `conversion_events (org, idempotency_key)`, `revenue_events (org, provider, external_id)`, `opportunities (org, fingerprint)`, `commissions (affiliate, revenue_event)`.
- Indexes cover tenant + status/time access paths (e.g. `conversion_events (org, type, occurred_at)`, `jobs (status, run_at)`).

---

## 4. Engines

### A. Product knowledge graph (single source of truth)
Onboarding (14 steps: identity → website → category → description → audience → problems → features → pricing → competitors → integrations → proof/sources → analytics → Search Console → conversion events) writes only to the graph. `computeCompleteness` weights 18 explicit items and lists exactly what is missing. Public surfaces use `verifiedOnly(graph)`.

### B. Discovery engine
`planPages` derives the page set (`/{product}`, `/{product}/features/{f}`, `/use-cases/`, `/industries/`, `/for/`, `/integrations/`, `/compare/`, `/alternatives/`, `/answers/`, `/changelog/`) **only when the graph holds enough material** (e.g. facet description ≥ 60 chars; comparisons need ≥ 3 sourced facts) and reports skipped pages with the reason. `assessPage` scores information completeness, factual confidence (verification × sourcing), intent match, duplicate similarity (word-shingle Jaccard) and usefulness. Pages failing any threshold cannot be published.

### C. SEO engine
SSRF-safe crawler (robots.txt aware, sitemap/sitemap-index discovery, page budget). Page rules: status, redirects, title/description, H1/hierarchy, canonical, robots/noindex, OpenGraph/Twitter, viewport, `lang`, image alt/dimensions, empty links, hreflang, JSON-LD validity, mixed content, thin/stale content, server-response and weight *signals* (explicitly not Core Web Vitals). Site rules: duplicate titles/descriptions, orphans, broken internal links, sitemap hygiene, missing entity schema. JSON-LD generators (`SoftwareApplication`/`WebApplication`, `Organization`, `Offer` (verified prices only), `FAQPage`, `Article`, `BreadcrumbList`, `HowTo` (only with ≥ 2 real steps)). Sitemaps and sitemap indexes are generated for published pages.

### D. GEO / AEO engine
Machine-readable entity profile per product with sourced claims, `unknowns` and `lastVerified`, published at `/api/v1/entity/{org}/{product}` (verified facts only). Answer blocks (“What is X?”, “Who is X for?”, “How much does X cost?”, “Does X support/integrate …?”, “Alternatives to …?”, FAQs) each cite their sources; questions without facts are returned as gaps. `llms.txt` per organisation.

### E. Query intelligence
Rule-based, explainable intent classifier (INFORMATIONAL, COMMERCIAL, TRANSACTIONAL, NAVIGATIONAL, COMPARISON, PROBLEM, ALTERNATIVE) with confidence and funnel stage; brand-aware. Query universe expansion combines category/keywords with audiences, industries, problems, features, integrations and competitors, de-duplicated by token set and capped; results are `CANDIDATE`s for human curation; long-tail variations are tracked, never mass-produced into pages. Coverage (NONE/PARTIAL/COVERED) is recomputed from page status.

### F. Visibility monitor
Provider adapters (`VisibilityAdapter`): Google Search Console (Search Analytics API, service-account JWT), GA4 Data API (sessions by channel incl. AI-assistant referrers), Bing Webmaster (rank & traffic). First-party events add visitors, CTA clicks and AI referrals (chatgpt.com, perplexity.ai, claude.ai, gemini, copilot, …). Metrics land in `visibility_metrics`; unconnected sources render as **Not connected**, never zero.

### G. AI visibility tests
Tracked prompts are sent to configured providers through official APIs; responses are parsed objectively (entities mentioned, order of first appearance, citations, own-domain citations) and stored as `SAMPLED_OBSERVATION`s with weekly trends. The UI states that samples do not represent every user’s AI response.

### H. Opportunity engine
Rules over measured evidence: content gaps, striking distance (positions 8 to 20), low CTR, AI-visibility gaps (competitors mentioned, product absent), critical/high technical issues, entity completeness, missing comparison facts, orphan pages, low-converting pages, visibility drops. Each opportunity carries evidence, competitors, ordered actions, impact/confidence/effort/urgency and `priority = impact × confidence × urgency ÷ effort`; potential is LOW/MEDIUM/HIGH only. Regeneration is idempotent and preserves human decisions; resolved conditions auto-close.

### I. AI content studio
`IDEA → GENERATED → FACT CHECK → SEO/GEO CHECK → HUMAN APPROVAL → APPROVED → PUBLISHED → performance`. The deterministic generator composes every sentence from graph facts (with `factRefs`) for 13 formats; missing material becomes `> TODO(editor):` markers that block approval. An optional LLM rewrite is constrained to the same facts and **kept only if it does not increase unsupported claims**. The fact checker flags invented numbers, customers, awards, ratings, superlatives and unsourced competitor claims. Only `content:approve` holders approve/publish.

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

### Q. Beacon Score
0 to 100 = Technical Discovery 20 + Content Coverage 20 + Entity Completeness 15 + Authority Signals 15 + Query Coverage 15 + Conversion Readiness 10 + Measurement Coverage 5. Every line shows earned/max and the reason; “Fastest path to N” ranks fixes by points per effort. It measures readiness, not rankings.

### R. Daily command center
“What needs my attention today?”: critical SEO problems, products losing organic visibility, high-potential opportunities, drafts ready for approval / blocked, pending external submissions, recommendations, experiments ready, referral conversions, commissions on hold, failing integrations, dead jobs, incomplete onboarding, ranked by impact × confidence × urgency ÷ effort. KPI groups (discovery, acquisition, revenue, ecosystem, content) compare equal-length periods.

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
| Server-side secrets only | No `NEXT_PUBLIC_*` secrets; env validated server-side; production refuses to start without encryption/hash keys or with the SSRF escape hatch on |
| Encrypted credentials | AES-256-GCM with per-integration AAD; plaintext never returned to the browser or logged |
| Authentication | scrypt (N=2¹⁵) passwords, ≥ 12 chars; opaque 256-bit session tokens stored as SHA-256; httpOnly + SameSite=Lax + Secure cookies; login rate limits (IP + email) and account lockout; constant-ish time for unknown users |
| RBAC | OWNER / ADMIN / EDITOR / ANALYST / VIEWER permission matrix enforced in every Server Action and API; members cannot grant roles ≥ their own; removing a member revokes their sessions |
| Tenant isolation | `organization_id` everywhere + Postgres **FORCE ROW LEVEL SECURITY** (fails closed); app also filters by org explicitly; run the app as a non-superuser role |
| Audit logging | Append-only `audit_logs` with redacted metadata for security- and content-relevant actions |
| Rate limiting | Postgres fixed-window buckets (multi-instance safe) on login, setup, ingestion, public endpoints, referral visits |
| Input validation & output encoding | zod on every action/API; React escaping; Markdown renderer escapes first and whitelists `http(s)`/relative links; JSON-LD serialised with `<`/`>`/`&` escaped |
| CSRF | Server Actions’ built-in Origin/Host check; cookie-authenticated mutations only via Server Actions; public APIs use API keys (no ambient credentials) |
| SSRF | Crawler: http(s) only, default ports, no credentials in URLs, DNS resolution validated **inside the socket lookup** (no rebinding), private/loopback/link-local/CGNAT/metadata ranges blocked, per-hop redirect re-validation, size/time caps |
| Webhooks | Stripe signature (HMAC-SHA256, constant-time compare, 5-minute tolerance) with encrypted per-integration secret; idempotent by event id |
| API keys | Prefixed, HMAC-hashed at rest, shown once via a short-lived path-scoped httpOnly cookie; publishable keys restricted to origins and PAGE_VIEW/CTA_CLICK |
| Open redirects | Referral and cross-sell destinations must be https on the product’s domain; `_back` redirects must be same-site relative paths |
| Privacy | Raw emails and IPs never stored (keyed HMACs); tracker honours DNT/GPC; cross-sell requires explicit consent |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `COOP`; `poweredByHeader` off |
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
- **Credentials**: the organisation's Anthropic key from Settings → Integrations (encrypted), else `ANTHROPIC_API_KEY`. Without one the agent says so.
- **Voice**: browser dictation (Web Speech API) and optional read-aloud; nothing audio is sent to the server.

## Media

`media` table (RLS) holds uploaded images re-encoded server-side with sharp (auto-orient, ≤2048 px, WebP, EXIF/GPS stripped, decompression-bomb guard). Public media (product photos, logos, content images) is served by unguessable id at `/api/media/[id]`; private media (agent chat photos) only to members of the organisation.

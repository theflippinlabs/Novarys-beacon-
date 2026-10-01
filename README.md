# Novarys Beacon

**Build once. Be found everywhere.**

Beacon is the distribution, discovery and growth engine of the Novarys ecosystem: the control tower that makes every Novarys product discoverable, measurable and commercially actionable. It is operational infrastructure, not an analytics dashboard and not an AI wrapper:

- a **product knowledge graph** (single source of truth, verification-aware, unknowns stay unknown);
- a **discovery engine** that plans product/feature/use-case/industry/audience/integration/comparison/answer pages behind a publication quality gate;
- a **technical SEO** crawler and Schema.org generator, plus a **GEO/AEO** entity layer (sourced answer blocks, entity JSON, `llms.txt`);
- **query intelligence**, a **visibility monitor** (Search Console, GA4, Bing, first-party events) and **sampled AI-visibility tests**;
- an evidence-based **opportunity engine**, a fact-checked **content studio**, a **distribution center** with human approval for external submissions;
- **conversion tracking**, explicit **attribution**, **referrals/affiliates**, **revenue**, consent-gated **cross-sell**, an explainable **AI sales agent**, a **growth autopilot** and the transparent **Beacon Score**.

Beacon never fakes visibility, rankings, citations or traffic, and never invents customers, testimonials, statistics, integrations, awards, reviews, pricing or competitor weaknesses.

→ Architecture, data model, security model and phases: [`docs/BEACON_ARCHITECTURE.md`](docs/BEACON_ARCHITECTURE.md)

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · PostgreSQL 16 + Drizzle ORM (row-level security) · Postgres job queue · Vitest · Playwright · Anthropic SDK (optional).

## Getting started

```bash
pnpm install
cp .env.example .env.local            # set DATABASE_URL, BEACON_ENCRYPTION_KEY, BEACON_HASH_SECRET
createdb beacon                        # with a NON-superuser role (superusers bypass RLS)
pnpm db:migrate
pnpm dev                               # http://localhost:3000 → /setup creates the first org + owner
pnpm worker                            # background jobs (or BEACON_EMBEDDED_WORKER=true)
```

Optional seed (bootstrap owner from env + Novarys product names only):

```bash
BEACON_BOOTSTRAP_ADMIN_EMAIL=you@novarys.app BEACON_BOOTSTRAP_ADMIN_PASSWORD='…12+ chars…' pnpm db:seed
```

Generate keys: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Onboarding a product

**Products → Add product** opens a 14-step wizard (identity, website, category, description, audience, problems, features, pricing, competitors, integrations, proof/sources, analytics, Search Console, conversion events). Finishing queues **product analysis**: entity model → query map → content-gap analysis → suggested pages → GEO/AEO questions → distribution suggestions → opportunities → Beacon Score, plus a live launch checklist. No code changes are needed to onboard another application.

Then: verify facts in the **Knowledge graph** tab, create tracking keys in **Tracking**, connect Search Console/GA4/Bing/Stripe/AI providers in **Settings → Integrations**.

## Product integration (API)

| Endpoint | Key | Purpose |
|---|---|---|
| `GET /beacon.js` + `data-key` | publishable | page views & CTA clicks (`data-beacon-cta`) |
| `POST /api/v1/events` | publishable (PAGE_VIEW/CTA_CLICK) / secret | conversion events |
| `POST /api/v1/identify` | secret | Novarys ID identity, consent, shared traits |
| `POST /api/v1/revenue` | secret | revenue & subscriptions (idempotent) |
| `GET /api/v1/cross-sell?identityRef=` · `POST /api/v1/cross-sell/event` | secret | ecosystem recommendations |
| `POST /api/webhooks/stripe/{integrationId}` | Stripe signature | revenue from Stripe |
| `GET /r/{CODE}` | none | referral links |
| `POST /api/v1/recommend` · `/ask/{org}` | none (rate-limited) | AI sales agent (verified facts only) |
| `GET /api/v1/entity/{org}/{product}` | none | machine-readable entity profile |
| `GET /api/v1/published/{org}/{product}` · `/p/{org}/sitemap.xml` · `/p/{org}/llms.txt` | none | published discovery content |
| `GET /api/health` | none | liveness/readiness |

## Quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test                 # unit (core engines, security, adapters)
pnpm test:integration     # Postgres (RLS, auth, workflows, APIs, webhooks), uses beacon_test
pnpm build
pnpm test:e2e             # Playwright journeys, uses beacon_e2e, runs `next dev` with the embedded worker
pnpm audit:deps
```

## Deployment

Run the web app (`pnpm start`) and at least one worker (`pnpm worker`) against PostgreSQL 16 using a non-superuser role; run `pnpm db:migrate` on release. A `Dockerfile` and `docker-compose.yml` (db, migrate, web, worker) are included. Required in production: `DATABASE_URL`, `BEACON_BASE_URL`, `BEACON_ENCRYPTION_KEY`, `BEACON_HASH_SECRET`. Never set `BEACON_SSRF_ALLOW_PRIVATE` in production (the app refuses to start).

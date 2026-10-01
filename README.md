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
# One-time per Postgres cluster: the BYPASSRLS system role used by asSystem (dev password: beacon_system)
sudo -u postgres psql -c "create role beacon_system login bypassrls password 'beacon_system'"
pnpm db:migrate
psql "$DATABASE_URL" -c "grant usage on schema public to beacon_system; grant select, insert, update, delete on all tables in schema public to beacon_system"
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
| `GET /api/health` | none (details: admin session or `x-beacon-health-secret`) | liveness/readiness |

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

Beacon runs as two services from the same image plus a release step:

| Service | Command | Notes |
|---|---|---|
| web | `pnpm start` | health check `GET /api/health` (anonymous: `{status}` only) |
| worker | `pnpm worker` | background jobs; refuses to start in production on an unsafe database role |
| release (pre-deploy) | `pnpm release` | `db:provision` (roles) then `db:migrate` |

**Railway.** Two services from this repository, configured in the Railway dashboard (no `railway.json`: a config file at the repository root would apply to both services and override the worker). Web service: Dockerfile build, start `pnpm start`, pre-deploy command `pnpm release`, health check `/api/health`, restart on failure. Worker service: start `pnpm worker`, no pre-deploy command, no health check, no public domain, the same variables.

**Database roles.** The provider's superuser URL goes in `DATABASE_ADMIN_URL` and is used only by the release step, which creates:

- the application role (`BEACON_DB_APP_USER`, default `beacon_app`, NOSUPERUSER NOBYPASSRLS): `DATABASE_URL` must connect as it; it runs migrations and every tenant query, so row-level security always applies;
- the system role (`BEACON_DB_SYSTEM_USER`, default `beacon_system`, BYPASSRLS, DML only): used by `asSystem` (authentication, the worker, key-resolved public APIs). The app connects as it with `BEACON_DB_SYSTEM_PASSWORD` (or `DATABASE_SYSTEM_URL`).

In production the release fails when the application role is a superuser/BYPASSRLS or the system role is missing, and web and worker refuse to start in the same situations. There is no session setting that bypasses RLS.

Required in production: `DATABASE_URL`, `BEACON_BASE_URL` (https), `BEACON_ENCRYPTION_KEY` (or `BEACON_ENCRYPTION_KEYS`), `BEACON_HASH_SECRET`, `BEACON_DB_SYSTEM_PASSWORD`, and for the release `DATABASE_ADMIN_URL` + `BEACON_DB_APP_PASSWORD`. `BEACON_SETUP_TOKEN` is needed while no user exists. Never set `BEACON_SSRF_ALLOW_PRIVATE` in production (the app refuses to start). See `.env.example` for every variable.

**Key rotation.** Prepend a new key to `BEACON_ENCRYPTION_KEYS` (`newkid:key,oldkid:key`; the legacy `BEACON_ENCRYPTION_KEY` is key id `v1`), deploy, run `pnpm secrets:rotate`, then remove the old key.

**docker-compose.** `docker-compose.yml` runs Postgres (superuser `postgres`), the release step, web and worker; set `POSTGRES_PASSWORD`, `BEACON_DB_APP_PASSWORD` and `BEACON_DB_SYSTEM_PASSWORD` in `.env`. The image has a Docker `HEALTHCHECK` and contains production dependencies only (`tsx` is a runtime dependency for the worker and release scripts).

**Tests and roles.** The integration global setup creates the system role once per cluster through `TEST_DATABASE_ADMIN_URL` (default `postgres://postgres:postgres@localhost:5432/<db>`; locally: `sudo -u postgres psql -c "alter role postgres password 'postgres'"`, or create `beacon_system` yourself as above) and grants it on the freshly migrated test database.

Security review: `docs/SECURITY_AUDIT.md`.

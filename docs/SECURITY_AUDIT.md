# Novarys Beacon: security audit (Phase 2, Wave 1)

Scope: the checks listed in the Phase 2 brief (section 31), applied to the repository as of Wave 1. Each entry states what was checked, the evidence (files), the finding, and the fix applied or the remaining risk. Audit item numbers (#NN) refer to `docs/PHASE2_AUDIT.md`. No secret values appear in this document.

Verification commands: `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm test:integration` (Postgres, RLS), `pnpm audit --prod`.

## Summary

| Check | Result after Wave 1 |
|---|---|
| Authentication bypass | No bypass found; login hardened (back-off instead of lockout, trusted client IP) |
| Authorization bypass | RBAC enforced by `act()`; matrix and denial tested; new `fact:verify` permission |
| IDOR | Fixed: form ids checked with `assertOwned`; private media restricted to the uploader |
| RLS | Fixed (P0): role split, no session-setting bypass, boot-time role check, RLS on `jobs` and `organizations` |
| SQL injection | No finding (parameterised queries; `sql.raw` only with constant column names) |
| XSS | Fixed: backslash links in Markdown; nonce-based CSP added |
| CSRF | Fixed: shared `sameOrigin()`; `Origin: null` answers 403 |
| SSRF | Fixed: 6to4, Teredo, NAT64 local-use and hex IPv4-mapped addresses blocked; hard request deadline |
| Open redirects | No finding |
| Secret exposure | Fixed: strict production environment, key ids and rotation, admin URL confined to release |
| API key leakage | No finding; cross-sell event now needs a product-scoped key with a cross-sell scope |
| Unsafe logging | Fixed: stored error texts redacted (`redactErrorText`) |
| Webhook validation | No finding on signatures; rate limit and streamed body cap added |
| Rate limiting | Fixed: all public routes and the Stripe webhook limited; IP keys no longer spoofable |
| File upload security | Fixed: private media visible to the uploader only (model included) |
| Dependency vulnerabilities | `pnpm audit --prod`: no known vulnerabilities |
| Tenant isolation | Fixed: parameterised test over every tenant table plus an action authorization matrix |

## 1. Authentication bypass

- Checked: session creation and resolution, password hashing, login and setup flows, session cookie, client IP used for limits.
- Evidence: `src/lib/auth/service.ts`, `src/lib/auth/session.ts`, `src/app/actions/auth.ts`, `src/lib/http.ts`, `src/db/migrations/0005_security_hardening.sql` (`login_throttle`).
- Finding: sessions are opaque 256-bit tokens stored as SHA-256, scrypt passwords, server expiry. Two weaknesses (#42): the client IP came from the first `X-Forwarded-For` entry (client-controlled, so per-IP limits could be dodged), and the hard lockout (10 failures, 15 minutes per account) let anyone lock any member out. `getAuthContext` was resolved several times per request.
- Fix: `clientIp()` / `ipHashOf()` take the entry added by the outermost trusted proxy (`BEACON_TRUSTED_PROXY_HOPS`, default 1 for Railway) and every caller uses it. The account lockout is replaced by exponential back-off per HMAC(email, IP) (free failures: 4, then 2 s doubling to 15 min) stored in `login_throttle` and incremented with one atomic upsert; unknown emails are throttled the same way, so responses reveal nothing. `getAuthContext` is memoized per request with React `cache()`. `/setup` still requires `BEACON_SETUP_TOKEN` in production while no user exists (runtime check).
- Tests: `tests/integration/auth.test.ts` (back-off per address, member unaffected from another address, unknown emails, parallel failures counted atomically), `tests/unit/security-hardening.test.ts` (IP selection, back-off curve).
- Update (Wave 2): sessions now end after 24 h without use (sliding) or 30 days after sign-in, and the production cookie is `__Host-beacon_session` (`core/auth/session-policy.ts`, `lib/auth/cookie.ts`). Remaining risk: a distributed guessing attack spread over many IPs is only bounded by the per-email fixed-window limit (10 per 15 min).

## 2. Authorization bypass

- Checked: every Server Action goes through `act()` / `actStaged()` (authenticate, `requirePermission`, zod, `withOrg`); route handlers check `can()`; the agent tools use the role filter.
- Evidence: `src/lib/actions.ts`, `src/lib/auth/rbac.ts`, `src/app/actions/*`, `src/agent/tools`.
- Finding (#43): an EDITOR could mark facts VERIFIED because verification shared `product:write`.
- Fix: new permission `fact:verify` (ADMIN, OWNER) exported from `rbac.ts` for the knowledge workflow; settings changes for the public site require `settings:manage` and are audited.
- Tests: `tests/integration/actions-authz.test.ts` runs real actions through `act()` (only `next/headers` and `redirect` are replaced) for every role: allowed roles succeed, others get the permission error, anonymous callers are sent to `/login` and nothing is written; the documented role matrix is asserted. `tests/unit/security-hardening.test.ts` checks `fact:verify`.
- Remaining risk: member invitation without consent and account-existence disclosure on "add member" (#43, P2) are not in Wave 1.

## 3. IDOR (insecure direct object references)

- Checked: ids taken from forms and URLs in actions, routes and the agent.
- Evidence: `src/lib/owned.ts`, `src/app/actions/products.ts`, `src/app/actions/growth.ts`, `src/app/api/media/[id]/route.ts`, `src/agent/loop.ts`.
- Finding (#44): Postgres foreign keys ignore RLS, so a member could attach another tenant's product, source, affiliate or campaign id to their own rows (proofs, changelog, FAQ sources, AI prompts, campaigns, experiments, cross-sell rules, referral codes). (#51): private chat photos were visible to every member of the organisation, and a member could reference another member's private photo id in their own agent conversation.
- Fix: `assertOwned(tx, table, id, orgId, message)` applied to `addProofAction`, `addChangelogAction`, `addFaqAction` (source), `addPromptAction`, `addCampaignAction`, `addExperimentAction`, `addCrossSellRuleAction`, `createReferralCodeAction`. `/api/media/[id]` serves PRIVATE media only to the uploader (`created_by`) signed in to the owning organisation, and the agent's history hydration drops another member's private photo before it reaches the model.
- Tests: `tests/integration/actions-authz.test.ts` (each action rejects org B's ids and writes nothing; own ids still work), `tests/integration/security-hardening.test.ts` (colleague gets 404, uploader 200).
- Remaining risk: composite (organization_id, id) foreign keys would enforce this in the database itself (planned, not in Wave 1).

## 4. Row-level security and database roles (#46, P0)

- Checked: policies, the bypass mechanism, roles used by the app, migrations and provisioning, docker-compose.
- Evidence: `src/db/migrations/0001_rls.sql`, `0005_security_hardening.sql`, `src/db/index.ts`, `src/db/roles.ts`, `src/db/provision.ts`, `src/lib/startup.ts`, `src/instrumentation.ts`, `src/jobs/run-worker.ts`, `docker-compose.yml`, `tests/support/global-setup.ts`.
- Finding: the bypass was a session setting (`beacon.bypass_rls`) that any SQL running as the app role could set; nothing refused to start as a superuser or BYPASSRLS role; provisioning silently skipped without `DATABASE_ADMIN_URL`; `jobs` and `organizations` had no RLS; compose ran as the superuser.
- Fix:
  - Migration 0005 rewrites `beacon_rls_allows(org)` to `org::text = current_setting('beacon.org_id', true)`: the setting-based bypass is gone for every existing and future policy.
  - `asSystem` (and `systemDb()` for the queue) uses a second pool that logs in as a separate role (`BEACON_DB_SYSTEM_USER`, default `beacon_system`, NOSUPERUSER BYPASSRLS, DML only), via `DATABASE_SYSTEM_URL` or `DATABASE_URL` with `BEACON_DB_SYSTEM_PASSWORD`. In production missing credentials are a startup error, never a fallback.
  - `pnpm release` (provision then migrate) creates the application role and the system role through `DATABASE_ADMIN_URL`, grants DML on all tables plus default privileges for tables created later by the app role, so the role exists before migration 0005 removes the old bypass. Without `DATABASE_ADMIN_URL`, production release fails when `DATABASE_URL` is a superuser/BYPASSRLS role or when the system role is missing or has no privileges; it skips only when the setup is already safe.
  - Boot check (web instrumentation and worker): in production, refuse to start when the app role is superuser or BYPASSRLS, or when the system role cannot connect, is a superuser, or lacks BYPASSRLS.
  - RLS enabled and forced on `jobs` (tenant scope sees its own jobs; system jobs with a null organisation only via the system role) and on `organizations` (a tenant scope sees only its own row). Foreign keys to `organizations` keep working (referential checks bypass RLS).
  - docker-compose: `postgres` superuser used only by the release service; web and worker connect as `beacon_app` with the system role password.
- Tests: `tests/integration/rls.test.ts` (stale BUG comments removed; the app role cannot bypass through `beacon.bypass_rls`, `row_security = off` is refused, the app role cannot `SET ROLE` to the system role, `asSystem` runs as a different non-superuser BYPASSRLS role, organisations and jobs isolation), `tests/integration/jobs.test.ts`.
- Remaining risk: the application role still owns the tables (it runs migrations), so code running as it could `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`; the app issues no dynamic DDL. A separate owner role for migrations is the next step. Data backfills in migrations must wrap themselves in `NO FORCE` / `FORCE ROW LEVEL SECURITY` (documented in 0005 and AGENTS.md), otherwise they touch no rows on existing data.

## 5. SQL injection

- Checked: every `sql` template, `sql.raw`, `execute` call.
- Evidence: `src/services/*.ts`, `src/jobs/queue.ts`, `src/lib/security/rate-limit.ts`.
- Finding: all queries use Drizzle builders or parameterised `sql` templates. `sql.raw` appears only with constant column names chosen in code (`services/metrics.ts`, `services/journey.ts`, `services/search-insights.ts`). Role names in provisioning are validated against `^[a-z_][a-z0-9_]{0,62}$` and passwords are quoted.
- Fix: none required. `withOrg` validates the organisation id format.

## 6. XSS

- Checked: `dangerouslySetInnerHTML` (4 uses: Markdown renderer for drafts, hosted pages and agent replies, JSON-LD), the Markdown link and image rules, security headers.
- Evidence: `src/core/content/markdown.ts`, `src/core/seo/schema-org.ts`, `src/proxy.ts`, `src/lib/csp.ts`, `next.config.ts`.
- Finding (#47, #52): `safeHref` accepted a slash followed by a backslash, which browsers turn into a protocol-relative link (open redirect / phishing link in hosted content); no Content-Security-Policy and no HSTS.
- Fix: `safeHref` refuses any backslash, control character or whitespace. A per-request nonce CSP is set on every HTML document by `src/proxy.ts`: `script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in development only), `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src 'self'` (agent NDJSON stream), images from self/data/blob/https, fonts self-hosted (`geist` via `next/font`, no Google Fonts), `upgrade-insecure-requests` when the base URL is https. APIs (CORS), `/beacon.js`, `/r/*` and static assets are exempt. HSTS (2 years, subdomains) on every response in production. Verified on a dev server: all Next scripts carry the nonce and the signed-in pages, settings toggle (Server Action) and agent page load without CSP violations.
- Tests: `tests/unit/security-hardening.test.ts` (XSS corpus for links, CSP directives and exemptions), existing Markdown tests.
- Remaining risk: `style-src` keeps `'unsafe-inline'` because React `style` attributes (charts) cannot carry nonces; styles cannot execute script.

## 7. CSRF

- Checked: Server Actions, cookie-authenticated route handlers (`/api/agent`, `/api/agent/upload`, `/api/media/upload`), public API routes.
- Evidence: `src/lib/http.ts` (`sameOrigin`), the three routes above.
- Finding (#47): each route parsed `Origin` with `new URL()`, so `Origin: null` produced a 500.
- Fix: one shared `sameOrigin(req)`: Origin must be present, parseable, not `null`, and equal to `BEACON_BASE_URL`'s origin or the request host; otherwise 403. Server Actions keep Next's built-in Origin check; public APIs use API keys, not cookies.
- Tests: `tests/unit/security-hardening.test.ts`.

## 8. SSRF

- Checked: `safeFetch` and its address filter, redirects, timeouts.
- Evidence: `src/lib/security/ssrf.ts`.
- Finding (#47): 6to4 (2002::/16) and Teredo (2001::/32) prefixes, which embed IPv4 addresses, were allowed; hex-form IPv4-mapped addresses were not normalised; the timeout was an idle timeout only, so a server dripping bytes could hold a worker.
- Fix: 6to4, Teredo and the NAT64 local-use prefix (64:ff9b:1::/48) are blocked; IPv4-mapped and IPv4-compatible addresses (dotted or hex) are checked against the IPv4 block list; every request has a hard wall-clock deadline in addition to the idle timeout. DNS validation inside the socket lookup and per-hop redirect checks are unchanged.
- Tests: `tests/unit/security-hardening.test.ts`, `tests/unit/security.test.ts`.

## 9. Open redirects

- Checked: `_back` targets, referral and cross-sell destinations, OAuth return paths.
- Evidence: `src/lib/actions.ts` (`safeBack`), `src/app/r/[code]/route.ts`, `src/app/actions/growth.ts` (`safeReferralDestination`).
- Finding: `_back` accepts only same-site relative paths without backslashes; referral and cross-sell destinations must be https on the product's domain. No finding.

## 10. Secret exposure

- Checked: environment handling, encryption at rest, which processes receive which credentials.
- Evidence: `src/lib/env.ts`, `src/lib/security/crypto.ts`, `src/db/rotate-secrets.ts`, `.env.example`, `docker-compose.yml`, `README.md`.
- Finding (#49): validation was lazy, `DATABASE_URL` and `BEACON_BASE_URL` defaulted to localhost even in production, `.env.example` was incomplete. (#48): the ciphertext envelope had no key id, so keys could not be rotated.
- Fix: `env()` is called eagerly at boot (instrumentation and worker); production requires `DATABASE_URL`, an https `BEACON_BASE_URL` (loopback http tolerated for local compose), encryption and hash secrets of at least 32 bytes, and system-role credentials, and refuses `BEACON_SSRF_ALLOW_PRIVATE`; all problems are reported at once. `.env.example` lists every variable with comments and no values. Envelope v2 `v2:<kid>:<iv>:<tag>:<ct>` with a key ring (`BEACON_ENCRYPTION_KEYS`, legacy `BEACON_ENCRYPTION_KEY` = kid `v1`); v1 envelopes still decrypt; `pnpm secrets:rotate` re-encrypts provider credentials. The superuser URL is used only by the release step.
- Tests: `tests/unit/security-hardening.test.ts` (production validation, key ring, v1 compatibility, AAD binding), `tests/integration/security-hardening.test.ts` (rotation keeps credentials readable).

## 11. API key leakage

- Checked: key storage and display, scopes, origin restrictions, cross-sell endpoints.
- Evidence: `src/services/tracking.ts`, `src/app/api/v1/*`, `src/app/actions/products.ts`.
- Finding: keys are HMAC-hashed at rest and shown once; publishable keys are origin-restricted. `POST /api/v1/cross-sell/event` accepted any secret key of the organisation.
- Fix: the event route requires a product-scoped secret key with a cross-sell scope (`crosssell:read` or `crosssell:write`), and the rule must involve that product (source or destination); unrelated products get 404.
- Tests: `tests/integration/security-hardening.test.ts`.

## 12. Unsafe logging

- Checked: the logger, stored error texts (`jobs.last_error`, `integrations.last_error`).
- Evidence: `src/lib/logger.ts`, `src/lib/security/redact.ts`, `src/jobs/queue.ts`, `src/services/stripe.ts`.
- Finding (#48): provider errors could carry URLs with `apikey=` (Bing) into `lastError`.
- Fix: `redactErrorText()` (`src/lib/security/redact.ts`) strips query strings, key/token parameters, bearer and basic credentials, JWTs, JSON secret fields, key-shaped tokens and Postgres URLs, then truncates. Applied to `jobs.last_error` and Stripe `lastError`; the integration health code has an equivalent sanitiser (`sanitizeProviderMessage`) and can switch to this helper. The JSON logger already redacts secret keys and key-shaped values.
- Tests: `tests/unit/security-hardening.test.ts`.

## 13. Webhook validation

- Checked: Stripe receiver.
- Evidence: `src/app/api/webhooks/stripe/[integrationId]/route.ts`, `src/services/stripe.ts`.
- Finding: HMAC-SHA256 over the raw body with constant-time comparison and a 5-minute tolerance, secret encrypted per integration, idempotent on the event id. The body was read in full before the size check and there was no rate limit.
- Fix: per-integration rate limit (600 per minute) and a streamed 512 KB body cap before verification.

## 14. Rate limiting (#50)

- Checked: every public route and authentication path.
- Evidence: `src/lib/http.ts` (`limited`, `pageRateLimited`, `readCappedText`), `src/app/ask/[org]/page.tsx`, `src/app/p/[org]/[...path]/page.tsx`, `src/app/p/[org]/sitemap.xml/route.ts`, `src/app/p/[org]/llms.txt/route.ts`, `src/app/api/v1/cross-sell/event/route.ts`, the Stripe route.
- Finding: no limits on `/ask`, `/p`, sitemap, llms.txt, cross-sell events and the Stripe webhook; IP keys were spoofable; `readJson` buffered the whole body first.
- Fix: limits added on all of them (by trusted client IP; Stripe by integration); `readJson` refuses a large `Content-Length` and stops a streamed body as soon as it exceeds the cap.
- Tests: `tests/unit/security-hardening.test.ts` (streamed cap), `tests/integration/security-hardening.test.ts` (413 on an oversized event).

## 15. File upload security

- Checked: upload routes and media service.
- Evidence: `src/services/media.ts`, `src/app/api/media/*`, `src/app/api/agent/upload/route.ts`.
- Finding: magic-byte sniffing, size and pixel caps, WebP re-encode with metadata stripped, strict response headers (`nosniff`, `default-src 'none'`). Private media were visible organisation-wide (see IDOR).
- Fix: uploader-only private media; uploads use the shared `sameOrigin()`.
- Update (Wave 2): re-encoding runs before any transaction opens (`prepareImage`), and the bytes are stored inside the tenant transaction (`insertImage`). Remaining risk (#51): bytes are still stored in PostgreSQL; object storage is planned.

## 16. Dependency vulnerabilities

- Checked: `pnpm audit --prod` on 2026-10-01.
- Finding: no known vulnerabilities. `tsx` moved to runtime dependencies (worker and release scripts) so the production image installs `--prod` only.
- Remaining risk: the audit is not yet run in CI (#57).

## 17. Tenant isolation (#54)

- Checked: every table in `TENANT_TABLES`, action-level authorization.
- Evidence: `tests/integration/tenant-isolation.test.ts`, `tests/integration/actions-authz.test.ts`, `tests/integration/rls.test.ts`.
- Finding: only products had a cross-tenant test.
- Fix: the isolation test builds one row for org B in every tenant table programmatically from the catalog (columns, enums, foreign keys resolved to org B's rows), asserts each table really has one, then checks that org A's scope can neither read, update nor delete any of them, and cannot move its own rows into org B. New tenant tables are covered automatically.

## Other platform fixes in this wave

- Jobs (#45, #30): idempotency keys scoped by organisation inside `enqueue`; `heartbeat_at` column refreshed through `ctx.heartbeat()` by the crawl and AI-visibility handlers; stale recovery uses the heartbeat and marks jobs DEAD once attempts are exhausted; `completeJob` / `failJob` check the lock owner; `maintenance.cleanup` deletes SUCCEEDED/CANCELLED jobs after 30 days (DEAD jobs and audit logs are kept: audit logs are never purged); the no-op `metrics.rollup` job type is removed.
- Public exposure (#53): `settings.publicSiteEnabled` (default on) is honoured by `orgBySlug`, so hosted pages, sitemap, llms.txt, entity and published APIs and `/ask` answer 404 when off (`/api/v1/recommend` finds no organisation); audited toggle on Settings. `/api/health` returns only `{status}` to anonymous callers; details for signed-in admins or with `BEACON_HEALTH_SECRET`.
- Deployment (#55): Railway web and worker services documented in the README (pre-deploy `pnpm release`, health check `/api/health`, restart on failure; no root `railway.json`, which would also apply to the worker), Docker `HEALTHCHECK`, production image without dev dependencies.
- Performance (#56): missing indexes added in 0005 with `IF NOT EXISTS` and mirrored in `schema.ts`.

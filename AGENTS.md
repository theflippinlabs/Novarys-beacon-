<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Novarys Beacon — notes for agents

- Read `docs/BEACON_ARCHITECTURE.md` first. Layering: `src/core` (pure, tested) → `src/services` (tenant-scoped `Tx`) → `src/app` (Server Actions via `act()`, route handlers).
- Every tenant table needs `organization_id`, an entry in `TENANT_TABLES` and an RLS policy migration; the integration suite enforces this.
- Data access in pages/actions goes through `withOrg` (`pageData` / `act`). Use `asSystem` only for trusted system paths (auth, worker, key-resolved public APIs).
- Never issue concurrent queries on one transaction (`Promise.all` on `tx`); use sequential awaits or `inSequence`.
- Never invent product claims or show fabricated numbers; unconnected data renders as "Not connected".
- UI colours follow the Beacon logo (navy-black surfaces, electric blue/cyan for focus and navigation, logo gold for primary actions); chart series use `--color-s1…s5` in order (validated palette — re-validate if you change it).
- Checks: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build && pnpm test:e2e`.

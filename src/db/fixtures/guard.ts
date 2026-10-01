/**
 * Demo-seed guard (pure, no database import): example data must never land in
 * a production database by accident. `pnpm db:seed:demo` refuses to run when
 * NODE_ENV=production unless BEACON_ALLOW_DEMO_SEED=true is set explicitly.
 */
export type DemoSeedDecision = { allowed: true } | { allowed: false; reason: string };

export function demoSeedDecision(env: Record<string, string | undefined>): DemoSeedDecision {
  if (env.NODE_ENV === "production" && env.BEACON_ALLOW_DEMO_SEED !== "true")
    return { allowed: false, reason: "Refusing to seed demo data: NODE_ENV=production. Set BEACON_ALLOW_DEMO_SEED=true to override (demo data is example content, not measured)." };
  return { allowed: true };
}

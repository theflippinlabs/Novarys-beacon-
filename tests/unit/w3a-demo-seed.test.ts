import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { demoSeedDecision } from "@/db/fixtures/guard";

describe("demo seed guard", () => {
  it("refuses in production unless BEACON_ALLOW_DEMO_SEED=true", () => {
    expect(demoSeedDecision({ NODE_ENV: "production" })).toMatchObject({ allowed: false });
    expect(demoSeedDecision({ NODE_ENV: "production", BEACON_ALLOW_DEMO_SEED: "false" })).toMatchObject({ allowed: false });
    expect(demoSeedDecision({ NODE_ENV: "production", BEACON_ALLOW_DEMO_SEED: "1" })).toMatchObject({ allowed: false });
    expect(demoSeedDecision({ NODE_ENV: "production", BEACON_ALLOW_DEMO_SEED: "true" })).toEqual({ allowed: true });
  });

  it("allows development and test", () => {
    expect(demoSeedDecision({})).toEqual({ allowed: true });
    expect(demoSeedDecision({ NODE_ENV: "development" })).toEqual({ allowed: true });
    expect(demoSeedDecision({ NODE_ENV: "test" })).toEqual({ allowed: true });
  });

  it("`pnpm db:seed:demo` exits before touching the database in production", () => {
    const r = spawnSync("npx", ["tsx", "src/db/seed-demo.ts"], {
      // An unreachable database: the script must refuse before connecting.
      env: { ...process.env, NODE_ENV: "production", BEACON_ALLOW_DEMO_SEED: "", DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Refusing to seed demo data");
  }, 60_000);

  it("the bootstrap seed carries no example content", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/db/seed.ts", "utf8");
    expect(src).not.toMatch(/aiVisibilityPrompts|addQuery|TikTok/);
  });
});

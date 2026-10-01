import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgres://beacon:beacon@localhost:5432/beacon_e2e";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.CI ? {} : { executablePath: "/opt/pw-browsers/chromium" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: `npx tsx tests/e2e/prepare-db.ts && pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DB,
      BEACON_BASE_URL: `http://localhost:${PORT}`,
      BEACON_EMBEDDED_WORKER: "true",
      BEACON_WORKER_CONCURRENCY: "2",
      // E2E audits a local fixture site; never enable this outside development/tests.
      BEACON_SSRF_ALLOW_PRIVATE: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      // The agent journey talks to a fake Claude API served by the fixture site.
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT ?? 3199}`,
    },
  },
});

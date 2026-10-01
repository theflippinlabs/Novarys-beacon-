import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testSystemUrl } from "./tests/support/db-urls";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://beacon:beacon@localhost:5432/beacon_test";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/support/global-setup.ts"],
          env: { DATABASE_URL: TEST_DB, DATABASE_SYSTEM_URL: testSystemUrl(TEST_DB), NODE_ENV: "test" },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

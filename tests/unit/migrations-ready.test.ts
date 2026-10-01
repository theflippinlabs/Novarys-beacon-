import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedMigrations } from "@/jobs/migrations-ready";

describe("worker migration wait", () => {
  it("expects exactly the migrations shipped with the build", () => {
    const sqlFiles = readdirSync(new URL("../../src/db/migrations", import.meta.url)).filter((f) => f.endsWith(".sql"));
    expect(expectedMigrations()).toBe(sqlFiles.length);
  });
});

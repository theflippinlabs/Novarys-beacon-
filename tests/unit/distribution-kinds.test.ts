import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_FOR_KIND, DISTRIBUTION_KINDS } from "@/core/distribution/catalog";
import { distributionKindEnum } from "@/db/schema";
import * as catalog from "@/core/distribution/catalog";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("distribution kinds", () => {
  it("has one list, equal to the database enum and covered by the category map", () => {
    expect([...DISTRIBUTION_KINDS]).toEqual(distributionKindEnum.enumValues);
    expect(Object.keys(CATEGORY_FOR_KIND).sort()).toEqual([...DISTRIBUTION_KINDS].sort());
  });

  it("is not copied anywhere else in the source (actions, pages, agent tools use DISTRIBUTION_KINDS)", () => {
    const src = join(process.cwd(), "src");
    const copies = files(src)
      .filter((f) => /"LAUNCH_PLATFORM",\s*"COMMUNITY",\s*"SOCIAL_CHANNEL"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    // The canonical constant (venues.ts) and the Postgres enum declaration (schema.ts) only.
    expect(copies.sort()).toEqual([join("core", "distribution", "venues.ts"), join("db", "schema.ts")].sort());
  });

  it("no longer exports the unused DISTRIBUTION_FLOW", () => {
    expect("DISTRIBUTION_FLOW" in catalog).toBe(false);
  });
});

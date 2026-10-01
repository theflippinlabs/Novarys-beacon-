import { describe, expect, it } from "vitest";
import { analystMetricsFor, CORE_SOURCES, INTEGRATION_CATALOG, isSearchProvider, SEARCH_PROVIDERS } from "@/integrations/registry";

describe("registry-driven provider lists", () => {
  it("core sources reported missing by the growth report are unchanged (catalogue order)", () => {
    expect(CORE_SOURCES).toEqual(["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "STRIPE"]);
  });

  it("integration errors link to the same analyst metrics as before", () => {
    expect(analystMetricsFor("GOOGLE_SEARCH_CONSOLE")).toEqual(["clicks", "impressions"]);
    expect(analystMetricsFor("BING_WEBMASTER")).toEqual(["clicks", "impressions"]);
    expect(analystMetricsFor("GOOGLE_ANALYTICS")).toEqual(["ai_referrals", "visitors"]);
    expect(analystMetricsFor("STRIPE")).toEqual(["new_subs", "beacon_mrr"]);
    expect(analystMetricsFor("ANTHROPIC")).toEqual([]);
    expect(analystMetricsFor("UNKNOWN")).toEqual([]);
  });

  it("search providers (query import after sync, search KPIs) are the search_daily writers", () => {
    expect([...SEARCH_PROVIDERS]).toEqual(["GOOGLE_SEARCH_CONSOLE", "BING_WEBMASTER"]);
    expect(isSearchProvider("GOOGLE_SEARCH_CONSOLE")).toBe(true);
    expect(isSearchProvider("BING_WEBMASTER")).toBe(true);
    expect(isSearchProvider("GOOGLE_ANALYTICS")).toBe(false);
    expect(isSearchProvider("STRIPE")).toBe(false);
    // Every search provider is a catalogued, syncable integration.
    for (const p of SEARCH_PROVIDERS) expect(INTEGRATION_CATALOG.find((c) => c.provider === p)?.syncable).toBe(true);
  });
});

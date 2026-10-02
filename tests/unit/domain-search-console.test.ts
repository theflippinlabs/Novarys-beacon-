import { describe, expect, it } from "vitest";
import { domainFromSearchConsoleProperty } from "@/core/seo/domains";

describe("domain proved by a Search Console property", () => {
  it("reads domain and URL-prefix properties", () => {
    expect(domainFromSearchConsoleProperty("sc-domain:Novarys.tech")).toBe("novarys.tech");
    expect(domainFromSearchConsoleProperty("https://www.novarys.tech/")).toBe("www.novarys.tech");
    expect(domainFromSearchConsoleProperty("http://shop.example.com/path/")).toBe("shop.example.com");
  });

  it("ignores anything else", () => {
    expect(domainFromSearchConsoleProperty("novarys.tech")).toBeNull();
    expect(domainFromSearchConsoleProperty("sc-domain:")).toBeNull();
    expect(domainFromSearchConsoleProperty("https://127.0.0.1/")).toBeNull();
  });
});

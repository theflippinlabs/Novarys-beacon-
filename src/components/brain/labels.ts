import type { T } from "@/i18n/core";
import type { Coverage, SpecialistKey } from "@/brain/types";

/** Literal keys so the French dictionary test covers them. */
export function specialistLabel(t: T, key: string): string {
  switch (key as SpecialistKey) {
    case "technical_seo":
      return t("Technical SEO");
    case "content_knowledge":
      return t("Content and knowledge");
    case "ai_visibility":
      return t("AI visibility and GEO");
    case "competitors":
      return t("Competitors");
    case "conversion_revenue":
      return t("Conversion and revenue");
    case "distribution_growth":
      return t("Distribution and growth");
  }
  return key;
}

export function coverageLabel(t: T, c: Coverage): string {
  return c === "MEASURED" ? t("Measured||coverage") : c === "PARTIAL" ? t("Partial||coverage") : t("Not connected");
}

export const coverageTone = (c: Coverage) => (c === "MEASURED" ? "ok" : c === "PARTIAL" ? "warn" : "muted") as "ok" | "warn" | "muted";

export function triggerLabel(t: T, trigger: string): string {
  return trigger === "MANUAL" ? t("Run now||brain trigger") : trigger === "AGENT" ? t("Beacon agent") : t("Weekly schedule");
}

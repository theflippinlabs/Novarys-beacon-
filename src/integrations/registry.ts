import { createBingAdapter } from "./bing";
import { createGa4Adapter } from "./ga4";
import { createSearchConsoleAdapter } from "./gsc";
import type { VisibilityAdapter } from "./types";

export const VISIBILITY_ADAPTERS: Record<VisibilityAdapter["provider"], () => VisibilityAdapter> = {
  GOOGLE_SEARCH_CONSOLE: () => createSearchConsoleAdapter(),
  GOOGLE_ANALYTICS: () => createGa4Adapter(),
  BING_WEBMASTER: () => createBingAdapter(),
};

export const isVisibilityProvider = (p: string): p is VisibilityAdapter["provider"] => p in VISIBILITY_ADAPTERS;

/** Catalogue shown in Settings → Integrations. Only providers with a working implementation are listed. */
export const INTEGRATION_CATALOG = [
  { provider: "GOOGLE_SEARCH_CONSOLE", scope: "product", kind: "Search visibility", description: "Impressions, clicks, positions and query data via the Search Analytics API." },
  { provider: "GOOGLE_ANALYTICS", scope: "product", kind: "Analytics", description: "Sessions by channel, including AI-assistant referrals, via the GA4 Data API." },
  { provider: "BING_WEBMASTER", scope: "product", kind: "Search visibility", description: "Bing impressions and clicks via the Bing Webmaster API." },
  { provider: "STRIPE", scope: "org", kind: "Revenue", description: "Subscription and payment events via signed webhooks." },
  { provider: "ANTHROPIC", scope: "org", kind: "AI provider", description: "Claude for content rewriting and sampled AI-visibility tests." },
  { provider: "OPENAI", scope: "org", kind: "AI provider", description: "Sampled AI-visibility tests via the OpenAI API." },
  { provider: "PERPLEXITY", scope: "org", kind: "AI provider", description: "Sampled AI-visibility tests with citations via the Perplexity API." },
] as const;

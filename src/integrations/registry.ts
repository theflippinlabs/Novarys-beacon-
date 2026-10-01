import { createBingAdapter } from "./bing";
import { createGa4Adapter } from "./ga4";
import { createSearchConsoleAdapter } from "./gsc";
import type { ConfigField, SearchCapability, SecretField, VisibilityAdapter } from "./types";

export const VISIBILITY_ADAPTERS: Record<VisibilityAdapter["provider"], () => VisibilityAdapter> = {
  GOOGLE_SEARCH_CONSOLE: () => createSearchConsoleAdapter(),
  GOOGLE_ANALYTICS: () => createGa4Adapter(),
  BING_WEBMASTER: () => createBingAdapter(),
};

export type VisibilityProvider = VisibilityAdapter["provider"];
export const isVisibilityProvider = (p: string): p is VisibilityProvider => p in VISIBILITY_ADAPTERS;

/** Providers synced by the worker (the scheduler and "Sync now" read this list). */
export const SYNC_PROVIDERS = Object.keys(VISIBILITY_ADAPTERS) as VisibilityProvider[];

/** Providers that write normalized rows into search_daily. */
export const SEARCH_PROVIDERS = ["GOOGLE_SEARCH_CONSOLE", "BING_WEBMASTER"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export const isSearchProvider = (p: string): p is SearchProvider => (SEARCH_PROVIDERS as readonly string[]).includes(p);

export type IntegrationProvider = VisibilityProvider | "STRIPE" | "ANTHROPIC" | "OPENAI" | "PERPLEXITY";

export type CatalogEntry = {
  provider: IntegrationProvider;
  label: string;
  scope: "product" | "org";
  kind: string;
  description: string;
  configFields: ConfigField[];
  secretFields: SecretField[];
  /** Synced by the worker. */
  syncable: boolean;
  capabilities: readonly SearchCapability[];
  /** Offers "Connect with Google" (OAuth) besides the form. */
  oauth?: "google";
};

const fromAdapter = (provider: VisibilityProvider, kind: string, description: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => {
  const a = VISIBILITY_ADAPTERS[provider]();
  return { provider, label: a.label, scope: "product", kind, description, configFields: a.configFields, secretFields: a.secretFields, syncable: true, capabilities: a.capabilities ?? [], ...extra };
};

const aiFields = (model: string): Pick<CatalogEntry, "configFields" | "secretFields"> => ({
  configFields: [{ key: "model", label: "Model (optional)", placeholder: model, required: false, hint: `Default: ${model}` }],
  secretFields: [{ key: "apiKey", label: "API key" }],
});

/**
 * Catalogue shown in Settings → Integrations, and the single source of the
 * provider list for the UI, the actions and the scheduler. Only providers
 * with a working implementation are listed. Form fields come from the
 * adapters' declarations.
 */
export const INTEGRATION_CATALOG: CatalogEntry[] = [
  fromAdapter("GOOGLE_SEARCH_CONSOLE", "Search visibility", "Daily clicks, impressions, CTR and positions by query, page, country and device via the Search Analytics API, with a 16-month backfill.", { oauth: "google" }),
  fromAdapter("GOOGLE_ANALYTICS", "Analytics", "Sessions by channel, including AI-assistant referrals, via the GA4 Data API."),
  fromAdapter("BING_WEBMASTER", "Search visibility", "Bing clicks and impressions by day, query and page via the Bing Webmaster API."),
  {
    provider: "STRIPE",
    label: "Stripe",
    scope: "org",
    kind: "Revenue",
    description: "Subscription and payment events via signed webhooks. Set metadata.beacon_identity (your user id, the identityRef sent to Beacon) on the Stripe customer's subscription or checkout session to link revenue to the person's acquisition journey; without it, revenue is linked to the Stripe customer only.",
    configFields: [{ key: "defaultProduct", label: "Default product slug", placeholder: "product-slug", required: false, hint: "Used when an event carries no metadata.beacon_product." }],
    secretFields: [
      {
        key: "webhookSecret",
        label: "Webhook signing secret",
        hint: "From the Stripe endpoint (whsec_…). Events: invoice.paid, customer.subscription.created/updated/deleted, checkout.session.completed, charge.refunded, refund.created.",
      },
    ],
    syncable: false,
    capabilities: [],
  },
  { provider: "ANTHROPIC", label: "Anthropic", scope: "org", kind: "AI provider", description: "Claude for content rewriting and sampled AI-visibility tests.", ...aiFields("claude-opus-5-5"), syncable: false, capabilities: [] },
  { provider: "OPENAI", label: "OpenAI", scope: "org", kind: "AI provider", description: "Sampled AI-visibility tests via the OpenAI API.", ...aiFields("gpt-5"), syncable: false, capabilities: [] },
  { provider: "PERPLEXITY", label: "Perplexity", scope: "org", kind: "AI provider", description: "Sampled AI-visibility tests with citations via the Perplexity API.", ...aiFields("sonar"), syncable: false, capabilities: [] },
];

export const INTEGRATION_PROVIDERS = INTEGRATION_CATALOG.map((c) => c.provider) as [IntegrationProvider, ...IntegrationProvider[]];

export const catalogEntry = (provider: string): CatalogEntry | undefined => INTEGRATION_CATALOG.find((c) => c.provider === provider);
export const isSyncableProvider = (p: string) => Boolean(catalogEntry(p)?.syncable);
export const isProductScoped = (p: string) => catalogEntry(p)?.scope === "product";

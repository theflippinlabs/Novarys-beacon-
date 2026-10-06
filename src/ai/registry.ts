import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, providerCredentials } from "@/db/schema";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/security/crypto";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type { LlmProvider, ProviderCredentials, ProviderId } from "./types";

const PROVIDER_INTEGRATION = { anthropic: "ANTHROPIC", openai: "OPENAI", perplexity: "PERPLEXITY" } as const;

/** API keys pasted on a phone can carry spaces, line breaks or invisible characters; no provider key contains them. */
export function cleanApiKey(key: string): string {
  return key.replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, "");
}

export function buildProvider(id: ProviderId, rawCreds: ProviderCredentials): LlmProvider {
  const creds = { ...rawCreds, apiKey: cleanApiKey(rawCreds.apiKey) };
  switch (id) {
    case "anthropic":
      return new AnthropicProvider({ ...creds, webSearch: env().BEACON_ANTHROPIC_WEB_SEARCH !== "false" });
    case "openai":
      return new OpenAICompatibleProvider("openai", "OpenAI", creds, { baseUrl: "https://api.openai.com/v1", model: "gpt-5" });
    case "perplexity":
      return new OpenAICompatibleProvider("perplexity", "Perplexity", creds, { baseUrl: "https://api.perplexity.ai", model: env().BEACON_PERPLEXITY_MODEL });
  }
}

/**
 * Resolve a provider for an organisation: org-level encrypted credentials
 * (Settings → Integrations) take precedence over deployment-wide environment
 * variables. Returns null when the provider is not configured.
 */
export async function resolveCredentials(tx: Tx, organizationId: string, id: ProviderId): Promise<ProviderCredentials | null> {
  const integ = await tx.query.integrations.findFirst({
    where: and(eq(integrations.organizationId, organizationId), eq(integrations.provider, PROVIDER_INTEGRATION[id]), isNull(integrations.productId)),
  });
  if (integ && integ.status !== "DISABLED") {
    const cred = await tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integ.id) });
    if (cred) {
      const secret = JSON.parse(decryptSecret(cred.ciphertext, integ.id)) as { apiKey: string };
      return { apiKey: secret.apiKey, model: integ.config.model };
    }
  }
  const e = env();
  if (id === "anthropic" && e.ANTHROPIC_API_KEY) return { apiKey: e.ANTHROPIC_API_KEY, model: e.BEACON_ANTHROPIC_MODEL };
  if (id === "openai" && e.OPENAI_API_KEY) return { apiKey: e.OPENAI_API_KEY, model: e.BEACON_OPENAI_MODEL };
  if (id === "perplexity" && e.PERPLEXITY_API_KEY) return { apiKey: e.PERPLEXITY_API_KEY, model: e.BEACON_PERPLEXITY_MODEL };
  return null;
}

export async function resolveProvider(tx: Tx, organizationId: string, id: ProviderId): Promise<LlmProvider | null> {
  const creds = await resolveCredentials(tx, organizationId, id);
  return creds ? buildProvider(id, creds) : null;
}

export async function availableProviders(tx: Tx, organizationId: string): Promise<LlmProvider[]> {
  const out: LlmProvider[] = [];
  for (const id of ["anthropic", "openai", "perplexity"] as const) {
    const p = await resolveProvider(tx, organizationId, id);
    if (p) out.push(p);
  }
  return out;
}

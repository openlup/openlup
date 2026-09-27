import { createNoopNewsletterSyncAdapter } from "../../adapters/noop_newsletter/noopNewsletterSyncAdapter.js";
import type { NewsletterSyncProviderPort } from "../../../src/domains/communications/ports.js";
import { newsletterProviderKindSchema } from "../../../src/domains/communications/newsletterIntegrationContracts.js";

export const COMMUNICATION_NEWSLETTER_PROVIDER_KINDS_ENV =
  "COMMUNICATION_NEWSLETTER_PROVIDER_KINDS";

export interface NewsletterProviderRegistryEnv {
  [key: string]: string | undefined;
  COMMUNICATION_NEWSLETTER_PROVIDER_KINDS?: string;
}

export function createNewsletterSyncProviderRegistry(
  env: NewsletterProviderRegistryEnv = process.env,
): NewsletterSyncProviderPort[] {
  const providerKinds = readProviderKinds(env);
  const providers = providerKinds
    .map(createProvider)
    .filter((provider): provider is NewsletterSyncProviderPort => Boolean(provider));

  return providers.length > 0 ? providers : [createNoopNewsletterSyncAdapter()];
}

function readProviderKinds(env: NewsletterProviderRegistryEnv): string[] {
  const raw = env.COMMUNICATION_NEWSLETTER_PROVIDER_KINDS;
  if (!raw?.trim()) return ["noop_newsletter"];
  return Array.from(new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => newsletterProviderKindSchema.safeParse(value).success),
  ));
}

function createProvider(providerKind: string): NewsletterSyncProviderPort | null {
  if (providerKind === "noop_newsletter") return createNoopNewsletterSyncAdapter();
  return null;
}

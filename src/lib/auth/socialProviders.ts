import { parseSocialProviders } from '@/domains/auth/providerList';
import type { OAuthProviderKind } from '@/domains/auth/types';

// Browser composition reads the configured provider list; adapters filter capabilities.

export function getEnabledSocialProviders(): OAuthProviderKind[] {
  return parseSocialProviders(import.meta.env.VITE_COMMERCE_SOCIAL_PROVIDERS);
}

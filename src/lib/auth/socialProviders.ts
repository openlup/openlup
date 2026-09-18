import { parseSocialProviders } from '@/domains/auth/providerList';
import type { OAuthProviderKind } from '@/domains/auth/types';

// Brand-layer env read for the enabled social providers (keeps the env access
// out of the OSS core domain). Configure via VITE_COMMERCE_SOCIAL_PROVIDERS,
// e.g. "google" or "google,apple,facebook". Default: Google only.

export function getEnabledSocialProviders(): OAuthProviderKind[] {
  return parseSocialProviders(import.meta.env.VITE_COMMERCE_SOCIAL_PROVIDERS);
}

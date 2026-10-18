import { isOAuthProviderKind, type OAuthProviderKind } from "./types.js";

export const DEFAULT_SOCIAL_PROVIDERS: readonly OAuthProviderKind[] = ["google"];


export function parseSocialProviders(raw: string | undefined): OAuthProviderKind[] {
  if (raw === undefined) return [...DEFAULT_SOCIAL_PROVIDERS];
  const kinds = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => isOAuthProviderKind(token));
  return [...new Set(kinds)];
}

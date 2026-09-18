import { isOAuthProviderKind, type OAuthProviderKind } from "./types.js";

// Pure parser for the enabled social-provider list. Generic (no env read — the
// brand layer supplies the raw string) so an adopter controls which providers
// the login surface offers via config. Default: Google only.

export const DEFAULT_SOCIAL_PROVIDERS: readonly OAuthProviderKind[] = ["google"];

/**
 * Parses a comma-separated provider list (e.g. "google,apple"). Unknown tokens
 * are dropped; order is preserved and de-duplicated. An unset value yields the
 * default; an explicit-but-empty value yields none (disables social sign-in).
 */
export function parseSocialProviders(raw: string | undefined): OAuthProviderKind[] {
  if (raw === undefined) return [...DEFAULT_SOCIAL_PROVIDERS];
  const kinds = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => isOAuthProviderKind(token));
  return [...new Set(kinds)];
}

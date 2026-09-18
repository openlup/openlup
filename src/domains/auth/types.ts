// Generic, provider-agnostic customer auth value types.
//
// OSS core: NO Supabase, NO secrets, NO brand literals. A future adopter swaps
// the adapter behind `CustomerAuthPort` without touching this file.

export const OAUTH_PROVIDER_KINDS = ["google", "apple", "facebook"] as const;
export type OAuthProviderKind = (typeof OAUTH_PROVIDER_KINDS)[number];

export function isOAuthProviderKind(value: string): value is OAuthProviderKind {
  return (OAUTH_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** The authenticated principal as the app needs it — not a provider session blob. */
export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthSession {
  accessToken: string;
  user: AuthUser;
}

export type AuthStateListener = (session: AuthSession | null) => void;
export type Unsubscribe = () => void;

/** A user-facing, already-localized error string, or null on success. */
export interface AuthActionResult {
  error: string | null;
}

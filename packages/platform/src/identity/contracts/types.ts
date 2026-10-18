export const OAUTH_PROVIDER_KINDS = ["google", "apple", "facebook"] as const;
export type OAuthProviderKind = (typeof OAUTH_PROVIDER_KINDS)[number];

export function isOAuthProviderKind(value: string): value is OAuthProviderKind {
  return (OAUTH_PROVIDER_KINDS as readonly string[]).includes(value);
}


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


export interface AuthActionResult {
  error: string | null;
}

import type {
  AuthActionResult,
  AuthSession,
  AuthStateListener,
  OAuthProviderKind,
  Unsubscribe,
} from "./types.js";

/**
 * Frontend customer auth port — the seam between UI/session code and whatever
 * auth provider backs it. The product app ships a Supabase adapter
 * (`src/integrations/supabase/customerAuthPort.ts`), but the UI depends only on
 * this interface so an OSS adopter can supply their own.
 *
 * `signInWithOtp` covers passwordless (magic-link) sign-in; `signInWithOAuth`
 * covers social providers. Both always request the provider's email so accounts
 * can be deduplicated by verified email server-side. `linkIdentity` attaches an
 * additional provider to the already-signed-in account (deliberate
 * consolidation; no destructive merge).
 */
export interface CustomerAuthPort {
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(listener: AuthStateListener): Unsubscribe;
  signInWithOtp(input: { email: string; locale: string }): Promise<AuthActionResult>;
  /**
   * Verify the one-time code printed under the magic-link button (the
   * "link doesn't work?" fallback) and establish the session. Supabase treats
   * this as the `magiclink` OTP type regardless of surface.
   */
  verifyOtpCode(input: { email: string; token: string }): Promise<AuthActionResult>;
  signInWithOAuth(input: {
    provider: OAuthProviderKind;
    redirectTo: string;
  }): Promise<AuthActionResult>;
  linkIdentity(input: {
    provider: OAuthProviderKind;
    redirectTo: string;
  }): Promise<AuthActionResult>;
  signOut(): Promise<void>;
}

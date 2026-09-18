import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdentityVerifierPort, VerifiedPrincipal } from "../../domains/auth/ports.js";

/**
 * Supabase execution adapter for the generic `IdentityVerifierPort`.
 *
 * Resolves an access token to its principal via `auth.getUser`. Email is treated
 * as verified when Supabase has confirmed it (admin-created/magic-link users have
 * `email_confirmed_at`; OAuth identities carry `user_metadata.email_verified`).
 */
export function createSupabaseIdentityVerifier(client: SupabaseClient): IdentityVerifierPort {
  return {
    async verifyAccessToken(accessToken: string): Promise<VerifiedPrincipal | null> {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) return null;

      const user = data.user;
      const metadataVerified = (user.user_metadata as { email_verified?: unknown } | null)
        ?.email_verified === true;
      return {
        principalId: user.id,
        email: user.email ?? null,
        emailVerified: Boolean(user.email_confirmed_at) || metadataVerified,
      };
    },
  };
}

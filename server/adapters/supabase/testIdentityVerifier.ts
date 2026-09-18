import type { IdentityVerifierPort, VerifiedPrincipal } from "../../domains/auth/ports.js";

/**
 * Test/simulator identity verifier — resolves any non-empty token to a fixed
 * principal. Used by unit tests and preview "test" auth mode so the reconcile
 * flow can be exercised without a real Supabase session. Never wired in live.
 */
export function createTestIdentityVerifier(
  principal: VerifiedPrincipal | null,
): IdentityVerifierPort {
  return {
    async verifyAccessToken(accessToken: string): Promise<VerifiedPrincipal | null> {
      if (!accessToken) return null;
      return principal;
    },
  };
}

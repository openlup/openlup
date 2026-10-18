import type { ManagedIdentityClient } from "./managedClient.js";
import type { IdentityVerifierPort, VerifiedPrincipal } from "./ports.js";


export function createSupabaseIdentityVerifier(rawClient: unknown): IdentityVerifierPort {
  const client = rawClient as ManagedIdentityClient;
  return {
    async verifyAccessToken(accessToken: string): Promise<VerifiedPrincipal | null> {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) return null;

      const user = data.user;
      return {
        principalId: user.id,
        email: user.email ?? null,
        emailVerified: Boolean(user.email_confirmed_at),
      };
    },
  };
}

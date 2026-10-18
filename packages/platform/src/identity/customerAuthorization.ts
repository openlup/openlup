import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { IdentityVerifierPort } from "./ports.js";
import type { ManagedIdentityClient } from "./managedClient.js";
import { createSupabaseIdentityVerifier } from "./managedIdentityVerifier.js";
export async function authenticateCustomerUserWith(
  verifier: IdentityVerifierPort,
  accessToken: string | null,
): Promise<CustomerUserAuthenticationResult> {
  if (!accessToken) {
    return { ok: false, code: "UNAUTHORIZED", message: "Customer session required" };
  }

  const principal = await verifier.verifyAccessToken(accessToken);
  if (!principal) {
    return { ok: false, code: "UNAUTHORIZED", message: "Customer session required" };
  }

  return { ok: true, userId: principal.principalId };
}


export async function optionalCustomerSubject(
  rawClient: unknown,
  accessToken: string | null,
): Promise<string | null> {
  const client = rawClient as ManagedIdentityClient;
  if (!accessToken) return null;
  const result = await authenticateCustomerUser(client, accessToken);
  return result.ok ? result.userId : null;
}

export async function authenticateCustomerUser(
  rawClient: unknown,
  accessToken: string | null,
): Promise<CustomerUserAuthenticationResult> {
  const client = rawClient as ManagedIdentityClient;
  return authenticateCustomerUserWith(createSupabaseIdentityVerifier(client), accessToken);
}

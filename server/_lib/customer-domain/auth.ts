import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CustomerUserAuthenticationResult } from "../../domains/customers/customerAuth.js";
import type { IdentityVerifierPort } from "../../domains/auth/ports.js";
import { createSupabaseIdentityVerifier } from "../../adapters/supabase/identityVerifier.js";

export type CustomerSupabaseClient = SupabaseClient;

export interface CustomerSelfServiceEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export interface CustomerSupabaseReadEnv {
  url: string;
  anonKey: string;
}

export function createCustomerClients(env: CustomerSelfServiceEnv, accessToken: string | null) {
  const customerClient = createCustomerClient(env, accessToken);
  const serviceClient = createCustomerServiceClient(env);
  return { customerClient, serviceClient };
}

export function createCustomerClient(env: CustomerSupabaseReadEnv, accessToken: string | null) {
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
  });
}

export function createCustomerServiceClient(env: CustomerSelfServiceEnv) {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve a customer access token to its principal through the generic
 * `IdentityVerifierPort` (UUID-keep: the principal id IS the Supabase auth uuid).
 * The default adapter wraps `client.auth.getUser` so behavior is byte-identical
 * to the inline call this replaced; OSS swaps the verifier without touching the
 * customer BFF call sites.
 */
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

/**
 * The customer this request PROVED it is, or `null` for a guest.
 *
 * The difference from `authenticateCustomerUser` is the whole point: this never
 * refuses. Guest checkout is a first-class flow, so a missing or invalid token
 * must degrade to "nobody proved anything" rather than to a 401 - while still
 * denying an anonymous caller the right to be treated as the account whose e-mail
 * they typed. Callers pass the result on as an identity to write with, never as a
 * permission to serve the request.
 */
export async function optionalCustomerSubject(
  client: CustomerSupabaseClient,
  accessToken: string | null,
): Promise<string | null> {
  if (!accessToken) return null;
  const result = await authenticateCustomerUser(client, accessToken);
  return result.ok ? result.userId : null;
}

export async function authenticateCustomerUser(
  client: CustomerSupabaseClient,
  accessToken: string | null,
): Promise<CustomerUserAuthenticationResult> {
  return authenticateCustomerUserWith(createSupabaseIdentityVerifier(client), accessToken);
}

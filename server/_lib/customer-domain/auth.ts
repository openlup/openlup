import { createManagedIdentityClients } from "@openlup/platform/identity";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const identityClients = createManagedIdentityClients(createClient);
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
  return identityClients.actor(env, accessToken) as unknown as CustomerSupabaseClient;
}

export function createCustomerServiceClient(env: CustomerSelfServiceEnv) {
  return identityClients.service(env) as unknown as CustomerSupabaseClient;
}


export { authenticateCustomerUserWith, authenticateCustomerUser, optionalCustomerSubject } from "@openlup/platform/identity";

// Supabase client factory for the DataGatewayPort.
//
// ONE canonical definition of the two supabase-js client shapes BFF handlers need:
//   - SERVICE-ROLE client (elevated, RLS-bypassing) — `createClient(url, serviceRoleKey, {auth:{...}})`
//   - ACTOR client (RLS-bound via a Bearer access token)  — anon key + `Authorization: Bearer <jwt>`
// Both use one exact option shape
// (`auth: { persistSession: false, autoRefreshToken: false }`, plus the actor's global Authorization
// header). The supabase-js `createClient`
// is always supplied by the application's composition root, so this package carries no SDK import
// and the adapter stays unit-testable without network.

/** Structural shape of the supabase-js `createClient` we depend on (injection seam for tests). */
export type SupabaseCreateClient = (
  url: string,
  key: string,
  options?: {
    auth?: { persistSession?: boolean; autoRefreshToken?: boolean };
    global?: { headers?: Record<string, string> };
  },
) => unknown;

export interface SupabaseDataGatewayEnv {
  /** Project URL (SUPABASE_URL / VITE_SUPABASE_URL). */
  url: string;
  /** Anon/publishable key — used for actor (RLS-bound) clients. */
  anonKey: string;
  /** Service-role key — used for elevated (RLS-bypassing) clients. */
  serviceRoleKey: string;
}

/** Read the gateway env using the same precedence the inline sites use today. */
export function readSupabaseDataGatewayEnv(
  env: Record<string, string | undefined>,
): SupabaseDataGatewayEnv | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
    env.SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  // anonKey is only needed for actor clients; service-role work needs only url + serviceRoleKey.
  // We require url + serviceRoleKey (the elevated path the default bundle uses); anonKey may be
  // empty for service-only deployments and is validated lazily when an actor client is requested.
  return url && serviceRoleKey ? { url, anonKey: anonKey ?? "", serviceRoleKey } : null;
}

/** Read env for actor-only gateway consumers. Does not require the elevated service-role key. */
export function readSupabaseActorDataGatewayEnv(
  env: Record<string, string | undefined>,
): SupabaseDataGatewayEnv | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
    env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "" } : null;
}

/**
 * Build an elevated (service-role) supabase client — byte-identical to the inline
 * `createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })`
 * shape the BFF handlers use today.
 */
export function createServiceClient(
  env: SupabaseDataGatewayEnv,
  factory: SupabaseCreateClient,
): unknown {
  return factory(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Build an actor (RLS-bound) supabase client — anon key + the actor's Bearer access token, matching
 * the inline `createAdminAuthClient` / `createCustomerClient` shape. When no token is supplied the
 * global Authorization header is omitted (identical to the inline `accessToken ? {...} : {}`).
 */
export function createActorClient(
  env: SupabaseDataGatewayEnv,
  accessToken: string | null,
  factory: SupabaseCreateClient,
): unknown {
  if (!env.anonKey) {
    throw new Error("supabase_data_gateway_actor_requires_anon_key");
  }
  return factory(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
  });
}

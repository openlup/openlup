import type { PlatformAdminAuthorizationResult } from "../../../domains/platform/adminAuth.js";
import { createSupabaseDataGateway } from "../../../adapters/supabase/dataGateway.js";
import { readSupabaseActorDataGatewayEnv } from "../../../adapters/supabase/dataGatewayClientFactory.js";
import {
  authorizeAdminWithUser,
  type SupabaseAuthClient,
} from "../../../_lib/admin-domain/auth.js";

export async function authorizePlatformAdmin(
  client: SupabaseAuthClient,
  accessToken: string | null,
): Promise<PlatformAdminAuthorizationResult> {
  return authorizeAdminWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export { readBearerToken } from "../../../_lib/admin-domain/auth.js";

export function readSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;

  return url && anonKey ? { url, anonKey } : null;
}

export function createPlatformActorDataGateway(accessToken: string | null) {
  const env = readSupabaseActorDataGatewayEnv();
  if (!env) return null;
  return createSupabaseDataGateway(env, {
    resolveAccessToken: () => accessToken,
  });
}

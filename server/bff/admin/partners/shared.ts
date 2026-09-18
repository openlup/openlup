import type { PartnersAdminAuthorizationResult } from "../../../domains/partners/adminAuth.js";
import {
  authorizeAdminWithUser,
  type SupabaseAuthClient,
} from "../../../_lib/admin-domain/auth.js";

export { readBearerToken } from "../../../_lib/admin-domain/auth.js";

export async function authorizePartnersAdmin(
  client: SupabaseAuthClient,
  accessToken: string | null,
): Promise<PartnersAdminAuthorizationResult> {
  return authorizeAdminWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export function readSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;

  return url && anonKey ? { url, anonKey } : null;
}

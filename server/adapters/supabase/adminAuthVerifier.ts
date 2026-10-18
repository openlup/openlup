import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminAuthFromEnv as createManagedAuth } from "@openlup/platform/identity";
export { createSupabaseAdminAuth } from "@openlup/platform/identity";
export function createSupabaseAdminAuthFromEnv(env: { url: string; anonKey: string }, accessToken: string | null) {
  return createManagedAuth(env, accessToken, createClient);
}

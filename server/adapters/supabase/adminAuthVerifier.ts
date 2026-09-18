import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/integrations/supabase/types.js";
import type {
  AdminAuthorizationResult,
  AdminAuthPort,
  AdminPrincipalRole,
} from "../../domains/auth/ports.js";
import {
  authorizeAdminWithUser,
  type AdminAuthorization,
} from "../../_lib/admin-domain/auth.js";

/**
 * Supabase execution adapter for the generic `AdminAuthPort`.
 *
 * UUID-keep: delegates to the existing `authorizeAdminWithUser` spine, so the
 * `EXISTS(admin_users WHERE id = auth.uid())` RLS-equivalent check and the
 * DB-derived `is_machine_actor` governance behave identically. The principal id
 * stays the Supabase auth uuid — no identity-mapping layer is introduced. This
 * adapter is a thin shape translation (`userId` -> `principalId`); all auth logic
 * remains in `server/_lib/admin-domain/auth.ts`.
 */
export function createSupabaseAdminAuth(client: SupabaseClient<Database>): AdminAuthPort {
  return {
    async authorize(
      accessToken: string | null,
      options?: { allowedRoles?: readonly AdminPrincipalRole[] },
    ): Promise<AdminAuthorizationResult> {
      const authz: AdminAuthorization = await authorizeAdminWithUser(client, accessToken, options);
      if (authz.ok === false) {
        return { ok: false, code: authz.code, message: authz.message };
      }
      return {
        ok: true,
        principalId: authz.userId,
        role: authz.role,
        isMachineActor: authz.isMachineActor,
      };
    },
  };
}

/** Build the adapter over a user-scoped admin auth client from explicit env. */
export function createSupabaseAdminAuthFromEnv(
  env: { url: string; anonKey: string },
  accessToken: string | null,
): AdminAuthPort {
  const client = createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
  });
  return createSupabaseAdminAuth(client);
}

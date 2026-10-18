import type { SupabaseCreateClient } from "../data/index.js";
import type { ManagedIdentityClient } from "./managedClient.js";
import type { AdminAuthPort, AdminAuthorizationResult, AdminPrincipalRole } from "./ports.js";
import { authorizeAdminWithUser, type AdminAuthorization } from "./adminAuthorization.js";

export function createSupabaseAdminAuth(rawClient: unknown): AdminAuthPort {
  const client = rawClient as ManagedIdentityClient;
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


export function createSupabaseAdminAuthFromEnv(
  env: { url: string; anonKey: string },
  accessToken: string | null,
  createClient: SupabaseCreateClient,
): AdminAuthPort {
  const client = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
  });
  return createSupabaseAdminAuth(client as ManagedIdentityClient);
}

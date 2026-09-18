import {
  authorizeAdminWithUser,
  readSupabaseAdminServiceEnv,
  type SupabaseAuthClient,
} from "../../../../_lib/admin-domain/auth.js";

export {
  createAdminAuthClient,
  readBearerToken,
} from "../../../../_lib/admin-domain/auth.js";

export function readSupabaseAdminCommerceFulfillmentEnv():
  | { url: string; anonKey: string; serviceRoleKey: string }
  | null {
  return readSupabaseAdminServiceEnv();
}

export async function authorizeCommerceFulfillmentAdminWithUser(
  client: SupabaseAuthClient,
  accessToken: string | null,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
> {
  return authorizeAdminWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

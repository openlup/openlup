import {
  authorizeAdminWithUser,
  readSupabaseAdminServiceEnv,
  type SupabaseAuthClient,
} from "../../../_lib/admin-domain/auth.js";

export {
  createAdminAuthClient,
  readBearerToken,
} from "../../../_lib/admin-domain/auth.js";

export function readSupabaseAdminAccountingEnv():
  | { url: string; anonKey: string; serviceRoleKey: string }
  | null {
  return readSupabaseAdminServiceEnv();
}

export async function authorizeAccountingAdminWithUser(
  client: SupabaseAuthClient,
  accessToken: string | null,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
> {
  return authorizeAdminWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export function accountingMutationsEnabled(): boolean {
  return process.env.COMMERCE_ACCOUNTING_MUTATIONS_ENABLED === "true";
}

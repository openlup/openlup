import { createSupabaseClientAuthLinkStore as createManagedClientAuthLinkStore } from "@openlup/platform/identity";
import { readCustomerRouteEnv } from "../../../bff/customers/shared.js";
import { resolveSupabaseAdminAuthEnv } from "../../../_lib/admin-domain/auth.js";
import { bindManagedIdentityEmailTrust } from "../../../runtime/auth/emailTrustBinding.js";

export function createSupabaseClientAuthLinkStore(client: unknown, env: Record<string, string | undefined> = readCustomerRouteEnv()) {
  return createManagedClientAuthLinkStore(client, { assess: async () => {
    const managed = resolveSupabaseAdminAuthEnv(env);
    if (!managed) throw new Error("Identity email-trust settings are not configured");
    return bindManagedIdentityEmailTrust(env, managed).assess();
  } });
}
import type { OperatorIdentityMovePort } from "../../../domains/support/operatorIdentityMove.js";

/**
 * The identity half of an operator e-mail correction.
 *
 * Separate factory from the linking store above on purpose: that one is reached
 * by checkout, and `moveIdentityEmail` is a verb checkout must never have.
 */
/**
 * Typed by the two capabilities it uses rather than by a vendor client: a table
 * read and an admin identity update. A port in the publishable slice should name
 * what it needs, not who provides it.
 */
type IdentityMoveClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }> };
      ilike: (column: string, value: string) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }> };
    };
  };
  auth: { admin: { updateUserById: (id: string, attrs: { email: string; email_confirm: boolean }) => Promise<{ error: unknown }> } };
};

export function createOperatorIdentityMovePort(client: IdentityMoveClient): OperatorIdentityMovePort {
  return {
    async findLinkedIdentity(clientId) {
      const { data, error } = await client
        .from("clients")
        .select("auth_user_id")
        .eq("id", clientId)
        .maybeSingle();
      if (error) throw error;
      const authUserId = data?.auth_user_id;
      return typeof authUserId === "string" && authUserId.length > 0 ? { authUserId } : null;
    },

    async findClientHoldingEmail(email) {
      // `idx_clients_email_lower` is the index that will refuse the write, so the
      // lookup that predicts the refusal must be case-insensitive the same way.
      const { data, error } = await client
        .from("clients")
        .select("id")
        .ilike("email", email.trim())
        .maybeSingle();
      if (error) throw error;
      const clientId = data?.id;
      return typeof clientId === "string" ? { clientId } : null;
    },

    async moveIdentityEmail(authUserId, email) {
      // `email_confirm` matters: without it the address change waits on a
      // confirmation mail sent to an address the subscriber may not be able to
      // reach, which is the situation this correction exists to escape.
      const { error } = await client.auth.admin.updateUserById(authUserId, {
        email: email.trim().toLowerCase(),
        email_confirm: true,
      });
      if (error) throw error;
    },
  };
}

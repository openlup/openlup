import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ClientAuthLinkStore } from "../../../domains/auth/ports.js";
import type { OperatorIdentityMovePort } from "../../../domains/support/operatorIdentityMove.js";

// Untyped SupabaseClient on purpose: the generated Database type predates the
// commerce tables, so clients/admin_users access uses the loose client — the
// same pattern as the other commerce BFF ports.
export function createSupabaseClientAuthLinkStore(client: SupabaseClient): ClientAuthLinkStore {
  return {
    async findClientByEmail(email) {
      // Resolve the OLDEST client row for the email, matching the deterministic
      // rule the order-attribution RPC uses (`ORDER BY created_at ASC LIMIT 1`,
      // migration 20260618100000). `.maybeSingle()` here was fragile: if an email
      // ever has >1 client row (fixture/real collision), PostgREST throws instead
      // of choosing, and the auth link could bind to a non-deterministic row —
      // the multi-client-per-email mislink class. `.limit(1)` on the ordered set
      // keeps login and order-attribution pointed at the same client.
      const { data, error } = await client
        .from("clients")
        .select("id, auth_user_id")
        .eq("email", email)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      if (!row) return null;
      return { id: row.id, authUserId: row.auth_user_id ?? null };
    },

    async findAuthUserIdByEmail(email) {
      const perPage = 1000;
      const maxUsers = 5000;
      let page = 1;
      let scanned = 0;

      while (scanned < maxUsers) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage });
        if (error) throw error;
        const users: User[] = data.users;
        const match = users.find(
          (u) => (u.email ?? "").trim().toLowerCase() === email,
        );
        if (match) return match.id;
        scanned += users.length;
        const nextPage = "nextPage" in data ? data.nextPage : null;
        if (!nextPage) return null;
        page = nextPage;
      }

      throw new Error("auth_user_lookup_cap_exceeded");
    },

    async findAuthUserEmailById(authUserId) {
      const { data, error } = await client.auth.admin.getUserById(authUserId);
      if (error) throw error;
      return data.user?.email ?? null;
    },

    async createAuthUser(email) {
      const { data, error } = await client.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      if (error) throw error;
      if (!data.user) throw new Error("createUser returned no user");
      return data.user.id;
    },

    async findAdminIdentity(authUserId) {
      const { data, error } = await client
        .from("admin_users")
        .select("id, is_machine_actor")
        .eq("id", authUserId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // Fail closed: mirror the activate RPC's `COALESCE(is_machine_actor, true)` —
      // only an explicit `false` is a human actor; anything else is a machine.
      return { isMachineActor: data.is_machine_actor !== false };
    },

    async setClientAuthUserId(clientId, authUserId) {
      const { data, error } = await client
        .from("clients")
        .update({ auth_user_id: authUserId })
        .eq("id", clientId)
        .is("auth_user_id", null)
        .select("auth_user_id")
        .maybeSingle();
      if (error) throw error;
      if (data?.auth_user_id === authUserId) {
        return { ok: true, alreadyLinked: false };
      }

      const { data: current, error: currentError } = await client
        .from("clients")
        .select("auth_user_id")
        .eq("id", clientId)
        .maybeSingle();
      if (currentError) throw currentError;
      if (current?.auth_user_id === authUserId) {
        return { ok: true, alreadyLinked: true };
      }
      return {
        ok: false,
        code: "CLIENT_AUTH_LINK_CONFLICT",
        existingAuthUserId: current?.auth_user_id ?? null,
      };
    },
  };
}

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

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AccountLinkStore,
  CreateAccountInput,
  CustomerAccount,
  LinkPrincipalResult,
} from "../../domains/auth/ports.js";

/**
 * Supabase execution adapter implementing the generic `AccountLinkStore` over
 * openlup's `clients` table (+ `admin_users` for reserved-principal refusal).
 *
 * Maps the domain-neutral `CustomerAccount {id, email, principalId}` onto
 * `clients {id, email, auth_user_id}`. The atomic link reuses the null-guarded
 * conditional update from `linkClientAuthUser` so concurrent links are detected
 * rather than silently overwriting an existing identity.
 *
 * Untyped SupabaseClient on purpose: the generated Database type predates the
 * commerce tables — same pattern as the other commerce ports. Must be built with
 * a service-role client (it writes `clients`).
 */
export function createSupabaseAccountLinkStore(client: SupabaseClient): AccountLinkStore {
  return {
    async findAccountByPrincipalId(principalId: string): Promise<CustomerAccount | null> {
      const { data, error } = await client
        .from("clients")
        .select("id, email, auth_user_id")
        .eq("auth_user_id", principalId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { id: data.id, email: data.email ?? null, principalId: data.auth_user_id ?? null };
    },

    async findAccountByEmail(email: string): Promise<CustomerAccount | null> {
      const { data, error } = await client
        .from("clients")
        .select("id, email, auth_user_id")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { id: data.id, email: data.email ?? null, principalId: data.auth_user_id ?? null };
    },

    async isReservedPrincipal(principalId: string): Promise<boolean> {
      // Only MACHINE/service admin identities are reserved. A HUMAN admin whose
      // verified email matches an unlinked client self-links their own identity
      // via the existing resolveByEmail → linkPrincipalToAccount path.
      const { data, error } = await client
        .from("admin_users")
        .select("id, is_machine_actor")
        .eq("id", principalId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return false;
      // Fail closed: mirror the activate RPC's `COALESCE(is_machine_actor, true)` —
      // only an explicit `false` is a human actor; anything else is a machine.
      return data.is_machine_actor !== false;
    },

    async linkPrincipalToAccount(
      accountId: string,
      principalId: string,
    ): Promise<LinkPrincipalResult> {
      const { data, error } = await client
        .from("clients")
        .update({ auth_user_id: principalId })
        .eq("id", accountId)
        .is("auth_user_id", null)
        .select("auth_user_id")
        .maybeSingle();
      if (error) throw error;
      if (data?.auth_user_id === principalId) {
        return { ok: true, alreadyLinked: false };
      }

      const { data: current, error: currentError } = await client
        .from("clients")
        .select("auth_user_id")
        .eq("id", accountId)
        .maybeSingle();
      if (currentError) throw currentError;
      if (current?.auth_user_id === principalId) {
        return { ok: true, alreadyLinked: true };
      }
      return { ok: false, existingPrincipalId: current?.auth_user_id ?? null };
    },

    async createAccount(input: CreateAccountInput): Promise<{ id: string }> {
      const { data, error } = await client
        .from("clients")
        .insert({
          email: input.email,
          auth_user_id: input.principalId,
          acquisition_source: input.acquisitionSource,
          lifecycle_stage: input.lifecycleStage,
        })
        .select("id")
        .single();
      // Surface unique-email races to the caller (reconcile retries the email
      // branch on insert failure rather than failing the sign-in).
      if (error) throw error;
      return { id: data.id };
    },
  };
}

import type { ManagedIdentityClient, ManagedIdentityRow } from "./managedClient.js";
import type {
  AccountLinkStore,
  CreateAccountInput,
  CustomerAccount,
  LinkPrincipalResult,
} from "./ports.js";


export function createSupabaseAccountLinkStore(rawClient: unknown): AccountLinkStore {
  const client = rawClient as ManagedIdentityClient;
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
      const rows = await findManagedContactsByEmail(client, email, false);
      if (rows.length > 1) {
        throw Object.assign(new Error("multiple rows returned"), { code: "PGRST116" });
      }
      const data = rows[0];
      if (!data) return null;
      return { id: data.id, email: data.email ?? null, principalId: data.auth_user_id ?? null };
    },

    async isReservedPrincipal(principalId: string): Promise<boolean> {
      const { data, error } = await client
        .from("admin_users")
        .select("id, is_machine_actor")
        .eq("id", principalId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return false;
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
      if (error) throw error;
      return { id: data!.id };
    },
  };
}

async function findManagedContactsByEmail(
  client: ManagedIdentityClient,
  email: string,
  oldestFirst: boolean,
): Promise<ManagedIdentityRow[]> {
  const normalized = email.trim().toLowerCase();
  // Escaping bounds the database prefilter; Unicode regex folding can still
  // widen it, so only exact normalized addresses may cross this boundary.
  let query = client.from("clients")
    .select("id, email, auth_user_id")
    .filter("email", "imatch", `^${normalized.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`);
  if (oldestFirst) query = query.order("created_at", { ascending: true });
  const { data, error } = await query.limit(10);
  if (error) throw error;
  return (data ?? []).filter((row) => row.email?.trim().toLowerCase() === normalized);
}

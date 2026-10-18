import type { ManagedIdentityClient, ManagedIdentityRow, ManagedIdentityUser } from "./managedClient.js";
import type { ClientAuthLinkStore } from "./ports.js";
export function createSupabaseClientAuthLinkStore(rawClient: unknown): ClientAuthLinkStore {
  const client = rawClient as ManagedIdentityClient;
  return {
    async findClientByEmail(email) {
      const rows = await findManagedContactsByEmail(client, email, true);
      const row = rows[0];
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
        const users: ManagedIdentityUser[] = data.users;
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
      if (error && isAlreadyRegistered(error)) return null;
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


function isAlreadyRegistered(error: unknown): boolean {
  const failure = (error ?? {}) as { code?: unknown; status?: unknown; message?: unknown };
  if (failure.code === "email_exists" || failure.code === "user_already_exists") return true;
  return failure.status === 422 && typeof failure.message === "string"
    && /already (been )?registered/i.test(failure.message);
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

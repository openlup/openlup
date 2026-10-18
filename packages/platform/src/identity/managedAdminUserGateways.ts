import type { InviteAdminUserGateway } from "./inviteAdminUserUseCase.js";
import type { RemoveAdminUserGateway } from "./removeAdminUserUseCase.js";
interface InviteAdminUserQuery {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): PromiseLike<{ data: { id: string; role?: string } | null }>;
    };
  };
  insert(row: { id: string; email: string; role: "admin" | "distributor" }):
    PromiseLike<{ error: { message: string } | null }>;
}

export interface InviteAdminUserClient {
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
    admin: {
      listUsers(options: { page: number; perPage: number }): PromiseLike<{ data: { users: Array<{ id: string; email?: string | null }>; nextPage?: number | null } | null; error: unknown }>;
      inviteUserByEmail(
        email: string,
        options: { redirectTo: string; data: Record<string, unknown> },
      ): PromiseLike<{
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }>;
    };
  };
  from(table: "admin_users"): InviteAdminUserQuery;
  rpc?: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

interface RemoveAdminUserQuery {
  select(columns: string): {
    eq(column: string, value: string): RemoveAdminUserQueryResult;
  };
}

interface RemoveAdminUserQueryResult {
  eq(column: string, value: string): RemoveAdminUserQueryResult;
  maybeSingle(): PromiseLike<{ data: { id: string; role: string } | null; error: { message: string } | null }>;
}

export interface RemoveAdminUserClient {
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
  };
  from(table: "admin_users"): RemoveAdminUserQuery;
  rpc(
    fn: "admin_revoke_admin_user",
    args: { p_target: string; p_reason: string | null },
  ): PromiseLike<{ error: { message: string } | null }>;
}

export function createInviteAdminUserGateway(clientFactory: () => InviteAdminUserClient): InviteAdminUserGateway {
  let client: InviteAdminUserClient | null = null;
  const getClient = (): InviteAdminUserClient => client ??= clientFactory();

  return {
    async getUser(accessToken) {
      const { data, error } = await getClient().auth.getUser(accessToken);
      return { user: data?.user ?? null, error };
    },
    async findAdminUser(userId) {
      const { data } = await getClient()
        .from("admin_users")
        .select("id, role")
        .eq("id", userId)
        .maybeSingle();
      return data && typeof data.role === "string" ? { id: data.id, role: data.role } : null;
    },
    async findAdminUserByEmail(email) {
      const { data } = await getClient()
        .from("admin_users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      return data ? { id: data.id } : null;
    },
    async findAuthUserByEmail(email) {
      const normalizedEmail = email.trim().toLowerCase();
      const perPage = 1000;
      const maxUsers = 5000;
      let page = 1;
      let scanned = 0;
      while (scanned < maxUsers) {
        const { data, error } = await getClient().auth.admin.listUsers({ page, perPage });
        if (error) throw error;
        const users = data?.users ?? [];
        const match = users.find((user) => (user.email ?? "").trim().toLowerCase() === normalizedEmail);
        if (match) return { id: match.id, email: match.email };
        scanned += users.length;
        if (!data?.nextPage) return null;
        page = data.nextPage;
      }
      throw new Error("auth_user_lookup_cap_exceeded");
    },
    async insertAdminUser(input) {
      return await getClient().from("admin_users").insert(input);
    },
    async inviteAuthUser(input) {
      const { data, error } = await getClient().auth.admin.inviteUserByEmail(input.email, {
        redirectTo: input.redirectTo,
        data: { admin_invite_role: input.role },
      });
      return { user: data.user, error };
    },
  };
}

export function createRemoveAdminUserGateway(clientFactory: () => RemoveAdminUserClient): RemoveAdminUserGateway {
  let client: RemoveAdminUserClient | null = null;
  const getClient = (): RemoveAdminUserClient => client ??= clientFactory();

  return {
    async getUser(accessToken) {
      const { data, error } = await getClient().auth.getUser(accessToken);
      return { user: data?.user ?? null, error };
    },
    async findAdminUser(userId) {
      const { data, error } = await getClient()
        .from("admin_users")
        .select("id, role")
        .eq("id", userId)
        .eq("membership_state", "active")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async revokeAdminUser(userId) {
      return await getClient().rpc("admin_revoke_admin_user", {
        p_target: userId,
        p_reason: null,
      });
    },
  };
}


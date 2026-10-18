import type { AdminUserInviteRole } from "./inviteAdminUserUseCase.js";
import type { ManagedOperatorMembershipResult, OperatorInvitationConflict } from "./contracts/operatorInvitations.js";
import type { ManagedIdentityClient } from "./managedClient.js";
import type { InviteAdminUserGateway } from "./inviteAdminUserUseCase.js";
import type { RemoveAdminUserGateway } from "./removeAdminUserUseCase.js";
interface InviteAdminUserQuery {
  insert(row: { id: string; email: string; role: AdminUserInviteRole; membership_state: "active"; membership_provenance: "invitation"; membership_accepted_at: string }): PromiseLike<{ error: { code?: string; message?: string } | null }>;
  select(columns: string): { eq(column: string, value: string): {
    maybeSingle(): PromiseLike<{ data: { id: string; role?: string; membership_state?: string; is_machine_actor?: boolean | null } | null; error?: unknown }>;
  } };
}
export interface InviteAdminUserClient {
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
    admin: {
      listUsers(options: { page: number; perPage: number }): PromiseLike<{ data: { users: Array<{ id: string; email?: string | null }>; nextPage?: number | null } | null; error: unknown }>;
      inviteUserByEmail(email: string, options: { redirectTo: string }): PromiseLike<{
        data: { user: { id: string } | null }; error: { message: string } | null;
      }>;
    };
  };
  from(table: "admin_users"): InviteAdminUserQuery;
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

export function createInviteAdminUserGateway(clientFactory: () => InviteAdminUserClient): InviteAdminUserGateway & {
  activateMembership(input: { principalId: string; email: string; role: AdminUserInviteRole }): Promise<ManagedOperatorMembershipResult | { code: OperatorInvitationConflict }>;
} {
  let client: InviteAdminUserClient | null = null;
  const getClient = (): InviteAdminUserClient => client ??= clientFactory();

  async function membership(principalId: string) {
    const { data, error } = await getClient().from("admin_users").select("id, role, membership_state, is_machine_actor").eq("id", principalId).maybeSingle();
    if (error) throw error;
    return data;
  }
  function existing(row: NonNullable<Awaited<ReturnType<typeof membership>>>, role: AdminUserInviteRole): ManagedOperatorMembershipResult | { code: OperatorInvitationConflict } {
    if (row.is_machine_actor !== false) return { code: "IDENTITY_CONFLICT" };
    if (row.membership_state === "revoked") return { code: "MANAGED_REINVITE_UNSUPPORTED" };
    if (row.membership_state !== "active") return { code: "IDENTITY_CONFLICT" };
    if (row.role !== role) return { code: "INVITATION_ROLE_CONFLICT" };
    return { principalId: row.id, role, membershipState: "active", code: "ALREADY_ACTIVE" };
  }
  return {
    async activateMembership(input) {
      const before = await membership(input.principalId);
      if (before) return existing(before, input.role);
      const { error } = await getClient().from("admin_users").insert({ id: input.principalId, email: input.email, role: input.role,
        membership_state: "active", membership_provenance: "invitation", membership_accepted_at: new Date().toISOString() });
      if (error) {
        if (error.code !== "23505") throw error;
        const raced = await membership(input.principalId);
        if (!raced) throw error;
        return existing(raced, input.role);
      }
      return { principalId: input.principalId, role: input.role, membershipState: "active", code: "MEMBERSHIP_CREATED" };
    },
    async getUser(accessToken) {
      const { data, error } = await getClient().auth.getUser(accessToken);
      return { user: data?.user ?? null, error };
    },
    async findAdminUser(userId) {
      const { data, error } = await getClient()
        .from("admin_users")
        .select("id, role, membership_state, is_machine_actor")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data && typeof data.role === "string" && typeof data.membership_state === "string" ? { id: data.id, role: data.role, membership_state: data.membership_state, is_machine_actor: data.is_machine_actor !== false } : null;
    },
    async findAdminUserByEmail(email) {
      const { data, error } = await getClient()
        .from("admin_users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;
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
    async inviteAuthUser(input) {
      const { data, error } = await getClient().auth.admin.inviteUserByEmail(input.email, {
        redirectTo: input.redirectTo,
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


/** Managed eligibility depends only on active native membership and known roles. */
export async function managedOperatorMagicLinkEligibility(rawClient: unknown, email: string): Promise<"eligible" | "not_allowlisted" | "role_not_allowed"> {
  const client = rawClient as ManagedIdentityClient;
  const { data, error } = await client.from("admin_users").select("id, role").eq("email", email.trim().toLowerCase()).eq("membership_state", "active").maybeSingle();
  if (error) throw error;
  if (!data) return "not_allowlisted";
  return data.role === "admin" || data.role === "distributor" ? "eligible" : "role_not_allowed";
}

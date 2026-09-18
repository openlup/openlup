import type { createClient } from "@supabase/supabase-js";

import type { AdminSettingsAdminUser } from "../../../../src/domains/platform/contracts.js";
import type { AdminSettingsPort } from "../../../../src/domains/platform/ports.js";
import type { Database } from "../../../../src/integrations/supabase/types.js";

type SupabaseClient = ReturnType<typeof createClient<Database>>;
type SettingInsert = Database["public"]["Tables"]["settings"]["Insert"];

interface RoleMutationRpcClient {
  rpc(
    fn: "admin_update_admin_user_role",
    args: { p_target: string; p_role: string },
  ): PromiseLike<{ error: { message?: string } | null }>;
}

export function createSupabaseAdminSettingsPort(
  client: SupabaseClient,
): Pick<AdminSettingsPort, "readSettings" | "updateSetting" | "updateAdminUserRole"> {
  return {
    async readSettings() {
      const [settings, adminUsers] = await Promise.all([
        client.from("settings").select("*"),
        client.from("admin_users")
          .select("id,email,role")
          .eq("membership_state", "active")
          .eq("is_machine_actor", false)
          .order("created_at"),
      ]);

      if (settings.error) throw settings.error;
      if (adminUsers.error) throw adminUsers.error;

      const settingsMap: Record<string, unknown> = {};
      for (const row of settings.data ?? []) {
        settingsMap[row.key] = row.value;
      }

      return {
        settings: settingsMap,
        adminUsers: (adminUsers.data ?? []) as unknown as AdminSettingsAdminUser[],
      };
    },

    async updateSetting(request) {
      const payload: SettingInsert = { key: request.key, value: request.value };
      const { error } = await client
        .from("settings")
        .upsert(payload, { onConflict: "key" });
      if (error) throw error;

      return { key: request.key, saved: true };
    },

    async updateAdminUserRole(request) {
      const { error } = await (client as unknown as RoleMutationRpcClient).rpc(
        "admin_update_admin_user_role",
        { p_target: request.userId, p_role: request.role },
      );
      if (error) throw mapRoleRpcError(error);

      return { userId: request.userId, role: request.role, saved: true };
    },
  };
}

/** Map the RPC's RAISE EXCEPTION messages to BFF-facing error codes. */
function mapRoleRpcError(error: { message?: string }): Error {
  const message = error.message ?? "";
  if (message.includes("self_role_change_forbidden")) {
    return Object.assign(new Error("You cannot change your own admin role."), { bffCode: "FORBIDDEN" });
  }
  if (message.includes("last_admin_lockout")) {
    return Object.assign(new Error("At least one admin must remain."), { bffCode: "CONFLICT" });
  }
  if (message.includes("target_membership_inactive")) {
    return Object.assign(new Error("The target no longer has active panel access."), { bffCode: "CONFLICT" });
  }
  if (message.includes("forbidden")) {
    return Object.assign(new Error("Admin role required."), { bffCode: "FORBIDDEN" });
  }
  if (message.includes("target_not_found")) {
    return Object.assign(new Error("Admin user not found."), { bffCode: "BAD_REQUEST" });
  }
  return error instanceof Error ? error : new Error(message || "Admin user role update failed");
}

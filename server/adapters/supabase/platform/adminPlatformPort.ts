import type { createClient } from "@supabase/supabase-js";

import {
  createAdminAuthClient,
  createServiceRoleClient,
} from "../../../_lib/admin-domain/auth.js";
import type { AdminMagicLinkRateLimitClient } from "../../../_lib/rate-limit/adminMagicLinkRateLimit.js";
import type {
  AdminPlatformMeResponse,
  AdminUserRole,
} from "../../../../src/domains/platform/contracts.js";
import type {
  AdminMagicLinkEligibility,
  AdminPlatformPort,
} from "../../../../src/domains/platform/ports.js";
import type { Database } from "../../../../src/integrations/supabase/types.js";
import type { PlatformUserAuthenticationResult } from "../../../domains/platform/adminAuth.js";

type SupabaseClient = ReturnType<typeof createClient<Database>>;

export interface AdminMagicLinkAuthClient {
  auth: {
    signInWithOtp(input: {
      email: string;
      options: { shouldCreateUser: false; emailRedirectTo: string };
    }): Promise<{ error: { name?: string; message?: string } | null }>;
  };
}

export function createAdminMagicLinkRuntime(env: {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}): {
  authClient: AdminMagicLinkAuthClient;
  platformPort: AdminPlatformPort;
  rateLimitClient: AdminMagicLinkRateLimitClient;
} {
  const serviceClient = createServiceRoleClient(env);
  return {
    authClient: createAdminAuthClient(env, null) as unknown as AdminMagicLinkAuthClient,
    platformPort: createSupabaseAdminPlatformPort(serviceClient as unknown as SupabaseClient),
    rateLimitClient: serviceClient as unknown as AdminMagicLinkRateLimitClient,
  };
}

export function createSupabaseAdminPlatformPort(client: SupabaseClient): AdminPlatformPort {
  return {
    async getAdminMe(userId): Promise<AdminPlatformMeResponse> {
      const { data, error } = await client
        .from("admin_users")
        .select("role")
        .eq("id", userId)
        .eq("membership_state", "active")
        .maybeSingle();
      if (error) throw error;

      if (!data) {
        return { isAdmin: false, role: null };
      }

      return { isAdmin: true, role: normalizeRole(data.role) };
    },

    async checkAdminMagicLinkEligibility(email): Promise<AdminMagicLinkEligibility> {
      const { data, error } = await client
        .from("admin_users")
        .select("id, role")
        .eq("email", email)
        .eq("membership_state", "active")
        .maybeSingle();
      if (error) throw error;
      if (!data) return "not_allowlisted";
      if (data.role === null || data.role === "admin" || data.role === "distributor") {
        return "eligible";
      }
      return "role_not_allowed";
    },
  };
}

export async function authenticateSupabasePlatformUser(
  client: SupabaseClient,
  accessToken: string | null,
): Promise<PlatformUserAuthenticationResult> {
  if (!accessToken) {
    return { ok: false, code: "UNAUTHORIZED", message: "Admin session required" };
  }

  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    return { ok: false, code: "UNAUTHORIZED", message: "Admin session required" };
  }

  return { ok: true, userId: data.user.id };
}

function normalizeRole(role: string | null): AdminUserRole {
  return role === "distributor" ? "distributor" : "admin";
}

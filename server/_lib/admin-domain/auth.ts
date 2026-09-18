import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import type { Database } from "../../../src/integrations/supabase/types.js";
import { sendBffError } from "../bff/response.js";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`api/_lib/admin-domain/`).
 *
 * Admin authorization spine shared by every agent-operable admin domain: bearer
 * extraction, the service-role + user-scoped Supabase clients, the admin-role
 * gate (re-derives the actor from `admin_users`), and the `resolveAdmin` handler
 * helper. Lifted verbatim from `api/bff/admin/commerce/shared.ts` and
 * `adminPromotionsHandler.ts`; those modules re-export from here for back-compat
 * so the ~90 existing BFF routes do not churn.
 *
 * Neutral home: imports nothing from `src/domains/*` / `api/domains/*`
 * (`kitIsDomainNeutral` guardrail).
 */

export type SupabaseAuthClient = ReturnType<typeof createClient<Database>>;
export type AdminRole = "admin" | "distributor";

export const DISTRIBUTOR_ADMIN_BFF_ROUTES = [
  "/api/bff/admin/fulfillment/dhl-book-courier",
  "/api/bff/admin/fulfillment/dhl-cleanup",
  "/api/bff/admin/fulfillment/dhl-clear-shipment-state",
  "/api/bff/admin/fulfillment/dhl-create-shipment",
  "/api/bff/admin/fulfillment/dhl-label",
  "/api/bff/admin/fulfillment/dhl-merge-labels",
  "/api/bff/admin/fulfillment/shipments-overview",
  "/api/bff/admin/tester-program/return-to-admin",
  "/api/bff/admin/tester-program/status",
] as const;

const DISTRIBUTOR_ROUTE_SET = new Set<string>(DISTRIBUTOR_ADMIN_BFF_ROUTES);

export const PUBLIC_ADMIN_BFF_ROUTES = [
  "/api/bff/admin/platform/me",
  "/api/bff/admin/platform/magic-link",
] as const;

const PUBLIC_ADMIN_ROUTE_SET = new Set<string>(PUBLIC_ADMIN_BFF_ROUTES);

export function readBearerToken(req: VercelRequest): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function resolveSupabaseServiceRoleEnv(env: Record<string, string | undefined>):
  | { url: string; serviceRoleKey: string }
  | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

export function readSupabaseAdminServiceEnv():
  | { url: string; anonKey: string; serviceRoleKey: string }
  | null {
  const auth = resolveSupabaseAdminAuthEnv(process.env);
  const service = resolveSupabaseServiceRoleEnv(process.env);
  return auth && service ? { ...auth, serviceRoleKey: service.serviceRoleKey } : null;
}

export function readSupabaseAdminCommerceEnv():
  | { url: string; anonKey: string; serviceRoleKey: string }
  | null {
  return readSupabaseAdminServiceEnv();
}

export function resolveSupabaseAdminAuthEnv(env: Record<string, string | undefined>):
  { url: string; anonKey: string } | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function readSupabaseAdminAuthEnv(): { url: string; anonKey: string } | null {
  return resolveSupabaseAdminAuthEnv(process.env);
}

export function createAdminAuthClient(
  env: { url: string; anonKey: string },
  accessToken: string | null,
): SupabaseAuthClient {
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
  });
}

export function createServiceRoleClient(env: { url: string; serviceRoleKey: string }) {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Authorization outcome: a resolved admin `userId`, or a typed denial. */
export type AdminAuthorization =
  | { ok: true; userId: string; role: AdminRole; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

/** A request-bound thunk that resolves the calling admin (or a denial). */
export type AuthorizeAdmin = () => Promise<AdminAuthorization>;

export async function authorizeAdminWithUser(
  client: SupabaseAuthClient,
  accessToken: string | null,
  options: { allowedRoles?: readonly AdminRole[] } = {},
): Promise<AdminAuthorization> {
  if (!accessToken) {
    return { ok: false, code: "UNAUTHORIZED", message: "Admin session required" };
  }

  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return { ok: false, code: "UNAUTHORIZED", message: "Admin session required" };
  }

  const { data, error } = await client
    .from("admin_users")
    .select("id, role, is_machine_actor")
    .eq("id", userData.user.id)
    .eq("membership_state", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { ok: false, code: "FORBIDDEN", message: "Admin role required" };
  }

  const role = normalizeAdminRole(data.role);
  if (options.allowedRoles && !options.allowedRoles.includes(role)) {
    return { ok: false, code: "FORBIDDEN", message: "Admin role required" };
  }

  // Fail closed: mirror the activate RPC's `COALESCE(is_machine_actor, true)` — only an
  // explicit `false` is a human actor; anything else is treated as a machine. The DB row
  // (`admin_users.is_machine_actor`, re-derived here and in every write RPC) is the single
  // source of truth for actor kind — never trusted from the caller.
  return {
    ok: true,
    userId: userData.user.id,
    role,
    isMachineActor: data.is_machine_actor !== false,
  };
}

export function authorizeCommerceAdminWithUser(
  client: SupabaseAuthClient,
  accessToken: string | null,
): Promise<AdminAuthorization> {
  return authorizeAdminWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export async function authorizeAdminBooleanWithUser(
  client: SupabaseAuthClient,
  accessToken: string | null,
  options: { allowedRoles?: readonly AdminRole[] } = {},
): Promise<boolean> {
  const authorization = await authorizeAdminWithUser(client, accessToken, options);
  return authorization.ok;
}

export function allowedAdminRolesForBffRoute(route: string): readonly AdminRole[] | null {
  if (!route.startsWith("/api/bff/admin/")) return null;
  if (PUBLIC_ADMIN_ROUTE_SET.has(route)) return null;
  if (DISTRIBUTOR_ROUTE_SET.has(route)) return ["admin", "distributor"];
  return ["admin"];
}

export async function preflightAdminBffRoute(
  req: VercelRequest,
  res: VercelResponse,
  route: string,
): Promise<boolean> {
  const allowedRoles = allowedAdminRolesForBffRoute(route);
  if (!allowedRoles) return true;

  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return false;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);
  let authz: AdminAuthorization;
  try {
    authz = await authorizeAdminWithUser(client, accessToken, { allowedRoles });
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }

  if (authz.ok === false) {
    sendBffError(res, authz.code, authz.message);
    return false;
  }
  return true;
}

/**
 * Shared authz gate: returns the resolved admin (`userId` + DB-derived
 * `isMachineActor`) or sends the error envelope and returns null.
 */
export async function resolveAdmin(
  authorizeAdmin: AuthorizeAdmin,
  res: VercelResponse,
): Promise<{ userId: string; role: AdminRole; isMachineActor: boolean } | null> {
  let authz: AdminAuthorization;
  try {
    authz = await authorizeAdmin();
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
  if (authz.ok === false) {
    sendBffError(res, authz.code, authz.message);
    return null;
  }
  return { userId: authz.userId, role: authz.role, isMachineActor: authz.isMachineActor };
}

function normalizeAdminRole(role: unknown): AdminRole {
  return role === "distributor" ? "distributor" : "admin";
}

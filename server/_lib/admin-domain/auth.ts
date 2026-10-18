import { readObservedResponseContext } from "../observability/requestContext.js";
import { createClient } from "@supabase/supabase-js";
import type { VercelResponse } from "../types/vercel.js";
import type { Database } from "../../../src/integrations/supabase/types.js";
import { createManagedIdentityClients, resolveAdmin as resolveIdentityAdmin } from "@openlup/platform/identity";
export { authorizeAdminWithUser, authorizeAdminBooleanWithUser, authorizeCommerceAdminWithUser, readBearerToken } from "@openlup/platform/identity";
export type { AdminAuthorization, AuthorizeAdmin } from "@openlup/platform/identity";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`server/_lib/admin-domain/`).
 *
 * Admin authorization spine shared by every agent-operable admin domain: bearer
 * extraction, the service-role + user-scoped Supabase clients, the admin-role
 * gate (re-derives the actor from `admin_users`), and the `resolveAdmin` handler
 * helper. Lifted verbatim from `server/bff/admin/commerce/shared.ts` and
 * `adminPromotionsHandler.ts`; those modules re-export from here for back-compat
 * so the ~90 existing BFF routes do not churn.
 *
 * Neutral home: imports nothing from `src/domains/*` / `server/domains/*`
 * (`kitIsDomainNeutral` guardrail).
 */

const identityClients = createManagedIdentityClients(createClient);
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
  return identityClients.actor(env, accessToken) as unknown as SupabaseAuthClient;
}

export function createServiceRoleClient(env: { url: string; serviceRoleKey: string }) {
  return identityClients.service(env) as unknown as ReturnType<typeof createClient>;
}

export function allowedAdminRolesForBffRoute(route: string): readonly AdminRole[] | null {
  if (!route.startsWith("/api/bff/admin/")) return null;
  if (PUBLIC_ADMIN_ROUTE_SET.has(route)) return null;
  if (DISTRIBUTOR_ROUTE_SET.has(route)) return ["admin", "distributor"];
  return ["admin"];
}

export const MACHINE_ACTOR_WRITE_ROUTES = [
  "/api/bff/admin/commerce/catalog/document-proposal",
  "/api/bff/admin/commerce/bundles/create",
  "/api/bff/admin/commerce/bundles/update",
  "/api/bff/admin/commerce/bundles/set-composition",
  "/api/bff/admin/commerce/bundles/set-target-price",
  "/api/bff/admin/commerce/bundles/archive",
  "/api/bff/admin/commerce/bundles/restore",
  "/api/bff/admin/commerce/bundles/clone-draft",
] as const;

export function resolveAdmin(authorizeAdmin: import("@openlup/platform/identity").AuthorizeAdmin, res: VercelResponse) {
  return resolveIdentityAdmin(authorizeAdmin, res, { responseRequestId: (response) => readObservedResponseContext(response)?.requestId });
}

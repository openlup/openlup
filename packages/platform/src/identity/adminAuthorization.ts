import type { HttpResponse, HttpRequest } from "../http/index.js";
import type { ManagedIdentityClient } from "./managedClient.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
export type AdminRole = "admin" | "distributor";

/** Authorization outcome: a resolved admin `userId`, or a typed denial. */
export type AdminAuthorization =
  | { ok: true; userId: string; role: AdminRole; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

/** A request-bound thunk that resolves the calling admin (or a denial). */
export type AuthorizeAdmin = () => Promise<AdminAuthorization>;

export async function authorizeAdminWithUser(
  rawClient: unknown,
  accessToken: string | null,
  options: { allowedRoles?: readonly AdminRole[] } = {},
): Promise<AdminAuthorization> {
  const client = rawClient as ManagedIdentityClient;
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
  if (role === null || (options.allowedRoles && !options.allowedRoles.includes(role))) {
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
  client: unknown,
  accessToken: string | null,
): Promise<AdminAuthorization> {
  return authorizeAdminWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export async function authorizeAdminBooleanWithUser(
  client: unknown,
  accessToken: string | null,
  options: { allowedRoles?: readonly AdminRole[] } = {},
): Promise<boolean> {
  const authorization = await authorizeAdminWithUser(client, accessToken, options);
  return authorization.ok;
}

/**
 * Shared authz gate: returns the resolved admin (`userId` + DB-derived
 * `isMachineActor`) or sends the error envelope and returns null.
 */
export async function resolveAdmin(
  authorizeAdmin: AuthorizeAdmin,
  res: HttpResponse,
  options: IdentityResponseOptions = {},
): Promise<{ userId: string; role: AdminRole; isMachineActor: boolean } | null> {
  const { sendBffError } = createIdentityResponder(options);
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

function normalizeAdminRole(role: unknown): AdminRole | null {
  return role === "admin" || role === "distributor" ? role : null;
}
export function readBearerToken(req: HttpRequest): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}


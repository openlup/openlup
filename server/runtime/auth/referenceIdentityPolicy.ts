import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DeploymentRouteOptions } from "../../_lib/publicDeploymentPolicies.js";
import { enforceDeploymentRoutePolicy as publicPolicy } from "../../_lib/publicDeploymentPolicies.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

export const IDENTITY_PAGES = new Set(["/sign-in", "/account", "/account/auth/callback", "/admin", "/admin/login", "/admin/auth/callback"]);
export const IDENTITY_ROUTES = new Map([
  ["/api/bff/customers/magic-link", "POST"], ["/api/bff/customers/verify-otp", "POST"],
  ["/api/bff/customers/me", "GET"], ["/api/bff/customers/reconcile-account", "POST"],
  ["/api/bff/admin/platform/magic-link", "POST"], ["/api/bff/admin/platform/verify-otp", "POST"],
  ["/api/bff/admin/platform/me", "GET"], ["/api/bff/admin/platform/admin-users/invite", "POST"],
  ["/api/bff/admin/platform/admin-users/remove", "POST"],
  ["/api/bff/admin/identity/privacy/export", "POST"], ["/api/bff/admin/identity/privacy/erase", "POST"],
]);
export type IdentityReferenceProfile = {
  origin: string; directory: string; runId: string; bundle: "node-postgres" | "node-supabase";
  assertOwned(): Promise<void>;
};
const active = new AsyncLocalStorage<IdentityReferenceProfile>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function identityLocalOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Identity reference requires a loopback HTTP origin");
  return url.origin;
}

/** The observer must check the live container identity and installation nonce, not just this file. */
export function validateIdentityReferenceProfile(env: Record<string, string | undefined>, observe: (profile: { runId: string; containerId: string; bundle: string; origin: string }) => Promise<void>): IdentityReferenceProfile {
  const bundle = env.PLATFORM_BUNDLE;
  if (env.OPENLUP_REFERENCE_PROFILE !== "identity" || env.OPENLUP_REFERENCE_DISPOSABLE !== "1"
    || env.NODE_ENV === "production" || env.APP_ENVIRONMENT || env.OPENLUP_ENVIRONMENT
    || ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION", "RAILWAY_ENVIRONMENT"].some(key => env[key])
    || (bundle !== "node-postgres" && bundle !== "node-supabase")) throw new Error("Identity reference requires an owned disposable local profile");
  const origin = identityLocalOrigin(env.APP_BASE_URL ?? "");
  const directory = resolve(env.OPENLUP_IDENTITY_RUN_DIR ?? "");
  const runId = env.OPENLUP_IDENTITY_RUN_ID ?? "";
  if (!env.OPENLUP_IDENTITY_RUN_DIR || !UUID.test(runId)) throw new Error("Identity reference ownership is required");
  const read = () => {
    if (realpathSync(directory) !== directory || (lstatSync(directory).mode & 0o777) !== 0o700) throw new Error("Identity reference directory must be private and canonical");
    const file = resolve(directory, "identity-owner.json");
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || (lstatSync(file).mode & 0o777) !== 0o600) throw new Error("Identity reference marker must be private");
    const marker = JSON.parse(readFileSync(file, "utf8"));
    if (marker.version !== 1 || marker.runId !== runId || marker.origin !== origin || marker.bundle !== bundle
      || !/^[a-f0-9]{64}$/.test(marker.containerId)) throw new Error("Identity reference installation mismatch");
    return { runId, origin, bundle, containerId: marker.containerId };
  };
  read();
  return { origin, directory, runId, bundle, async assertOwned() { await observe(read()); } };
}

/** Await ownership before entering the alias-bound route, body reader or authentication factory. */
export async function withIdentityReferencePolicy<T>(profile: IdentityReferenceProfile, work: () => Promise<T>): Promise<T> {
  await profile.assertOwned();
  return active.run(profile, work);
}

/** Selected only by the disposable server build's #deployment-route-policy alias. */
export function enforceDeploymentRoutePolicy(options: DeploymentRouteOptions, req: Pick<VercelRequest, "headers" | "method">, res: VercelResponse): boolean {
  const profile = active.getStore();
  if (!profile) return publicPolicy(options, req, res);
  const method = IDENTITY_ROUTES.get(options.route);
  if (method && req.method === method && req.headers.host === new URL(profile.origin).host
    && (method === "GET" || (req.headers.origin === profile.origin
      && typeof req.headers["content-type"] === "string" && req.headers["content-type"].split(";", 1)[0].trim() === "application/json"))) return true;
  res.status(503).json({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Identity reference policy refused route", details: { reason: "adopter_policy_required" } } });
  return false;
}

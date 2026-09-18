import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import {
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "../shared.js";

/**
 * Composition root for the admin-commerce CATALOG routes.
 *
 * Collapses the env-read + env-null guard + infra-client construction prelude
 * that the 12 standard catalog routes share VERBATIM (activate, archive,
 * archive-product, clone-draft, create, deactivate, get, history, list,
 * restore, set-price, update). On a missing env it OWNS the failure response
 * (`UPSTREAM_UNAVAILABLE` / "Admin catalog is not configured" — byte-identical
 * across all 12) and returns `null`; the caller just early-returns.
 *
 * Deliberately NOT used by `sku-eans.ts`: it reads a different env
 * (`readSupabaseActorDataGatewayEnv`), responds `INTERNAL` /
 * "Supabase environment is not configured", and authorizes via a different
 * path — folding it in would erase that distinction. Per-route feature-flag
 * gating, the `authorizeCommerceAdminWithUser` closure, and port instantiation
 * stay at the call-site.
 */
export function composeAdminCatalog(
  req: VercelRequest,
  res: VercelResponse,
):
  | {
      accessToken: ReturnType<typeof readBearerToken>;
      authClient: ReturnType<typeof createAdminAuthClient>;
      serviceClient: ReturnType<typeof createServiceRoleClient>;
    }
  | null {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin catalog is not configured");
    return null;
  }
  const accessToken = readBearerToken(req);
  return {
    accessToken,
    authClient: createAdminAuthClient(env, accessToken),
    serviceClient: createServiceRoleClient(env),
  };
}

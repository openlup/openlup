import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import {
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "../shared.js";
import { readCommercePromotionPreviewHmacSecret } from "../shared.js";

export function composeAdminPromotionCodes(
  req: VercelRequest,
  res: VercelResponse,
  options: { requirePreviewSecret?: boolean } = {},
) {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Promotion code administration is not configured");
    return null;
  }
  const previewSecret = readCommercePromotionPreviewHmacSecret();
  if (options.requirePreviewSecret && !previewSecret) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Promotion preview signing is not configured");
    return null;
  }
  const accessToken = readBearerToken(req);
  return {
    accessToken,
    authClient: createAdminAuthClient(env, accessToken),
    serviceClient: createServiceRoleClient(env),
    previewSecret: previewSecret ?? "",
  };
}

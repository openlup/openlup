import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminAuthClient } from "../../../../_lib/admin-domain/auth.js";
import {
  authorizePlatformAdmin,
  readBearerToken,
  readSupabaseEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }
  const accessToken = readBearerToken(req);
  const authorization = await authorizePlatformAdmin(
    createAdminAuthClient(env, accessToken),
    accessToken,
  );
  if (authorization.ok === false) {
    sendBffError(res, authorization.code, authorization.message);
    return;
  }
  sendBffError(res, "NOT_FOUND", "Standalone DHL tracking is retired", {
    details: { reason: "direct_dhl_tracking_retired" },
  });
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/pipeline/dhl-tracking-refresh",
  domain: "platform",
  surface: "admin",
  risk: "provider",
}, handler);

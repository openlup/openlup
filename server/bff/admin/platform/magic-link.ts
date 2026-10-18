import { readObservedResponseContext } from "../../../_lib/observability/requestContext.js";
import { createAdminMagicLinkHandler } from "@openlup/platform/identity";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  readSupabaseAdminServiceEnv,
} from "../../../_lib/admin-domain/auth.js";
import {
  createAdminMagicLinkRuntime,
} from "../../../adapters/supabase/platform/adminPlatformPort.js";
import {
  adminMagicLinkRequestSchema,
  adminMagicLinkResponseSchema,
} from "../../../../src/domains/platform/contracts.js";
import {
  checkAndRecordAdminMagicLinkAttempt,
  extractClientIp,
} from "../../../_lib/rate-limit/adminMagicLinkRateLimit.js";
import { padResponseTime } from "../../../_lib/timing.js";

const ADMIN_AUTH_CALLBACK_PATH = "/admin/auth/callback";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createAdminMagicLinkHandler({
    responseRequestId: (res) => readObservedResponseContext(res)?.requestId,
    requestSchema: adminMagicLinkRequestSchema, responseSchema: adminMagicLinkResponseSchema,
    readEnvironment: readSupabaseAdminServiceEnv, createRuntime: createAdminMagicLinkRuntime,
    checkAttempt: checkAndRecordAdminMagicLinkAttempt, extractClientIp, padResponseTime,
    redirectOrigins: [process.env.APP_BASE_URL?.trim() || process.env.SITE_URL?.trim() || ""], callbackPath: ADMIN_AUTH_CALLBACK_PATH,
  })(req, res);
}
export default withObservedRoute({
  route: "/api/bff/admin/platform/magic-link",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);

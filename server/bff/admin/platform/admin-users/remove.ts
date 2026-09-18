import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminUserRemoveHandler } from "../../../../domains/platform/adminSettingsHandlers.js";
import { createAdminAuthClient } from "../../../../_lib/admin-domain/auth.js";
import {
  createSupabaseAdminUserRemovePort,
} from "../../../../adapters/supabase/adminUserActionPort.js";
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
  const client = createAdminAuthClient(env, accessToken);

  return createAdminUserRemoveHandler({
    settingsPort: createSupabaseAdminUserRemovePort({ accessToken }),
    authorizeAdmin: () => authorizePlatformAdmin(client, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/admin-users/remove",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);

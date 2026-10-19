import { readCustomerRouteEnv as readRouteEnvironment } from "../../../customers/shared.js";
import { createDirectOperatorActionsBinding, type DirectOperatorActionOptions } from "../../../../runtime/auth/operatorActionsBinding.js";
import { readObservedResponseContext } from "../../../../_lib/observability/requestContext.js";
import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminUserInviteHandler } from "@openlup/platform/identity";
import { createAdminAuthClient } from "../../../../_lib/admin-domain/auth.js";
import {
  createSupabaseAdminUserInvitePort,
} from "../../../../adapters/supabase/adminUserActionPort.js";
import {
  authorizePlatformAdmin,
  readBearerToken,
  readSupabaseEnv,
} from "../shared.js";

export function createInviteHandler(options: DirectOperatorActionOptions = {}) {
return withObservedRoute({ route: "/api/bff/admin/platform/admin-users/invite", domain: "platform", surface: "admin", risk: "mutation" }, async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (readRouteEnvironment().PLATFORM_BUNDLE === "node-postgres") {
    let binding: ReturnType<typeof createDirectOperatorActionsBinding> | undefined;
    try {
      binding = createDirectOperatorActionsBinding(readRouteEnvironment(), readBearerToken(req), options);
      return await createAdminUserInviteHandler({
        responseRequestId: response => readObservedResponseContext(response)?.requestId,
        settingsPort: binding.invitePort, authorizeAdmin: binding.authorizeAdmin,
      })(req, res);
    } catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operator action unavailable"); }
    finally { await binding?.close(); }
    return;
  }
  const env = readSupabaseEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  return createAdminUserInviteHandler({
    responseRequestId: (res) => readObservedResponseContext(res)?.requestId,
    settingsPort: createSupabaseAdminUserInvitePort({ accessToken }),
    authorizeAdmin: () => authorizePlatformAdmin(client, accessToken),
  })(req, res);
});
}

export default createInviteHandler();

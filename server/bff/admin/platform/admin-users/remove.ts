import { readCustomerRouteEnv as readRouteEnvironment } from "../../../customers/shared.js";
import { createDirectOperatorActionsBinding, type DirectOperatorActionOptions } from "../../../../runtime/auth/operatorActionsBinding.js";
import { readObservedResponseContext } from "../../../../_lib/observability/requestContext.js";
import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminUserRemoveHandler } from "@openlup/platform/identity";
import { createAdminAuthClient } from "../../../../_lib/admin-domain/auth.js";
import {
  createSupabaseAdminUserRemovePort,
} from "../../../../adapters/supabase/adminUserActionPort.js";
import {
  authorizePlatformAdmin,
  readBearerToken,
  readSupabaseEnv,
} from "../shared.js";

export function createRemoveHandler(options: DirectOperatorActionOptions = {}) {
return withObservedRoute({ route: "/api/bff/admin/platform/admin-users/remove", domain: "platform", surface: "admin", risk: "mutation" }, async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (readRouteEnvironment().PLATFORM_BUNDLE === "node-postgres") {
    let binding: ReturnType<typeof createDirectOperatorActionsBinding> | undefined;
    try {
      binding = createDirectOperatorActionsBinding(readRouteEnvironment(), readBearerToken(req), options);
      return await createAdminUserRemoveHandler({
        responseRequestId: response => readObservedResponseContext(response)?.requestId,
        settingsPort: binding.removePort, authorizeAdmin: binding.authorizeAdmin,
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

  return createAdminUserRemoveHandler({
    responseRequestId: (res) => readObservedResponseContext(res)?.requestId,
    settingsPort: createSupabaseAdminUserRemovePort({ accessToken }),
    authorizeAdmin: () => authorizePlatformAdmin(client, accessToken),
  })(req, res);
});
}

export default createRemoveHandler();

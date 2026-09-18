import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createStartHiddenCheckoutRuntimeHandler } from "../../../../domains/commerce/commerceRuntimeHandlers.js";
import {
  authorizeCommerceAdminWithUser,
  commerceRuntimeMutationsEnabled,
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "../shared.js";
import { createHiddenCommerceRuntimePort } from "./runtimeComposition.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Hidden commerce runtime is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const serviceClient = createServiceRoleClient(env);
  const runtimePort = createHiddenCommerceRuntimePort(serviceClient);

  return createStartHiddenCheckoutRuntimeHandler({
    runtimePort,
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
    mutationsEnabled: commerceRuntimeMutationsEnabled,
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/commerce/runtime/start",
  domain: "commerce",
  surface: "admin",
  risk: "mutation",
}, handler);

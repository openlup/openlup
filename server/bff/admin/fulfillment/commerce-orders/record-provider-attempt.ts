import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminCommerceFulfillmentRecordProviderAttemptHandler } from "../../../../domains/fulfillment/commerceFulfillmentHandlers.js";
import { createSupabaseAdminCommerceFulfillmentGateway } from "../../../../adapters/supabase/adminCommerceFulfillmentGateway.js";
import {
  authorizeCommerceFulfillmentAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminCommerceFulfillmentEnv,
} from "./shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceFulfillmentEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce fulfillment is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const gateway = createSupabaseAdminCommerceFulfillmentGateway(env);

  return createAdminCommerceFulfillmentRecordProviderAttemptHandler({
    fulfillmentPort: gateway.mutationPort,
    authorizeAdmin: () => authorizeCommerceFulfillmentAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/commerce-orders/record-provider-attempt",
  domain: "fulfillment",
  surface: "admin",
  risk: "mutation",
}, handler);

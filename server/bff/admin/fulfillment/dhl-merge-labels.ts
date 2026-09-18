import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createFulfillmentDhlMergeLabelsHandler,
} from "../../../domains/fulfillment/dhlShipmentHandler.js";
import { createDhlMergeLabelsPort } from "../../../adapters/dhl/labelsAdapter.js";
import {
  authorizeFulfillmentAdmin,
  createFulfillmentAdminAuthContext,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const auth = createFulfillmentAdminAuthContext(req);
  if (!auth) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  return createFulfillmentDhlMergeLabelsHandler({
    shipmentPort: createDhlMergeLabelsPort({ accessToken: auth.accessToken }),
    authorizeAdmin: () => authorizeFulfillmentAdmin(auth.client, auth.accessToken, ["admin", "distributor"]),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/dhl-merge-labels",
  domain: "fulfillment",
  surface: "admin",
  risk: "provider",
}, handler);

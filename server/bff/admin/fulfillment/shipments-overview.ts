import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createFulfillmentShipmentsOverviewHandler } from "../../../domains/fulfillment/shipmentsOverviewHandler.js";
import {
  createSupabaseShipmentsOverviewPort,
  type ShipmentsOverviewSupabaseClient,
} from "../../../adapters/supabase/shipmentsOverviewPort.js";
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

  return createFulfillmentShipmentsOverviewHandler({
    overviewPort: createSupabaseShipmentsOverviewPort(
      auth.client as unknown as ShipmentsOverviewSupabaseClient,
    ),
    authorizeAdmin: () => authorizeFulfillmentAdmin(auth.client, auth.accessToken, ["admin", "distributor"]),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/shipments-overview",
  domain: "fulfillment",
  surface: "admin",
  risk: "mutation",
}, handler);

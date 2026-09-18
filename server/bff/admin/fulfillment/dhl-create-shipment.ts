import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  refuseRetiredDirectDhlAction,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return refuseRetiredDirectDhlAction(req, res, {
    allowedRoles: ["admin", "distributor"],
    reason: "direct_dhl_new_intake_retired",
    message: "New standalone DHL fulfillment is retired",
  });
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/dhl-create-shipment",
  domain: "fulfillment",
  surface: "admin",
  risk: "provider",
}, handler);

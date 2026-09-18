import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  refuseRetiredDirectDhlAction,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return refuseRetiredDirectDhlAction(req, res, {
    allowedRoles: ["admin", "distributor"],
    reason: "direct_dhl_remote_cleanup_retired",
    message: "Standalone DHL remote cleanup is retired",
  });
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/dhl-cleanup",
  domain: "fulfillment",
  surface: "admin",
  risk: "provider",
}, handler);

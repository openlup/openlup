import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createPickupPointSearchHandler } from "../../domains/shipping/deliverySelectionHandler.js";
import { createHiddenPickupPointSearchRoute } from "./shared.js";

const pickupPointSearchHandler = createHiddenPickupPointSearchRoute((port) =>
  createPickupPointSearchHandler(port),
);

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return pickupPointSearchHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/shipping/pickup-point-search",
  domain: "shipping",
  surface: "hidden",
  risk: "read",
}, handler);

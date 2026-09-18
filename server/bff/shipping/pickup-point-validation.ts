import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createPickupPointValidationHandler } from "../../domains/shipping/deliverySelectionHandler.js";
import { createHiddenDeliverySelectionRoute } from "./shared.js";

const pickupPointValidationHandler = createHiddenDeliverySelectionRoute((port) =>
  createPickupPointValidationHandler(port),
);

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return pickupPointValidationHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/shipping/pickup-point-validation",
  domain: "shipping",
  surface: "hidden",
  risk: "validation_mutation",
}, handler);

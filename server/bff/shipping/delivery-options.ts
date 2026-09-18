import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createDeliveryOptionsHandler } from "../../domains/shipping/deliverySelectionHandler.js";
import { createHiddenDeliverySelectionRoute } from "./shared.js";

const deliveryOptionsHandler = createHiddenDeliverySelectionRoute((port) =>
  createDeliveryOptionsHandler(port),
);

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return deliveryOptionsHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/shipping/delivery-options",
  domain: "shipping",
  surface: "hidden",
  risk: "read",
}, handler);

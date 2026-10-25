import { createAdminCommerceOrderRequestReplacementShipmentHandler as createHandler } from "@openlup/platform/fulfillment";
import type { CommerceOmsHoldPort } from "../../../src/domains/commerce/omsPorts.js";
import type { BaseDeps } from "./commerceOmsHandlers.js";
import { bindManagedHandler, managedReplacementPort, fulfillmentResponder } from "../../shared/fulfillment/managedOperatorBinding.js";

// Pass through all 18 named refusal reasons unchanged so operators never receive database text.
export function createAdminCommerceOrderRequestReplacementShipmentHandler(deps: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "requestReplacementShipment">;
}) {
  return bindManagedHandler(authorizeAdmin => createHandler({
    ...deps, authorizeAdmin, respond: fulfillmentResponder, omsPort: managedReplacementPort(deps.omsPort),
  }), deps.authorizeAdmin);
}

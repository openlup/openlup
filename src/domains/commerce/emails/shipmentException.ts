import { createShipmentExceptionContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";

export type { ShipmentExceptionEmailVars, ShipmentExceptionEmailContent } from "@openlup/platform/communications/contracts";
export const { shipmentExceptionEmailContent } = createShipmentExceptionContentFactory({ commerceEmailContent, formatCustomerOrderReference });

import { createShipmentDeliveredContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { ShipmentDeliveredEmailVars as NeutralShipmentDeliveredEmailVars } from "@openlup/platform/communications/contracts";
import type { ShipmentDeliveredEmailContent } from "@openlup/platform/communications/contracts";

export type { ShipmentDeliveredEmailContent } from "@openlup/platform/communications/contracts";
export interface ShipmentDeliveredEmailVars extends Omit<NeutralShipmentDeliveredEmailVars, "contextName"> {
  petName?: string | null;
}
const content = createShipmentDeliveredContentFactory({ commerceEmailContent, formatCustomerOrderReference });
export function shipmentDeliveredEmailContent(locale: Locale, vars: ShipmentDeliveredEmailVars, signoff: string): ShipmentDeliveredEmailContent {
  return content.shipmentDeliveredEmailContent(locale, { ...vars, contextName: vars.petName }, signoff);
}

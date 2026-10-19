import { createShipmentDispatchedContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { ShipmentDispatchedEmailVars as NeutralShipmentDispatchedEmailVars } from "@openlup/platform/communications/contracts";
import type { ShipmentDispatchedEmailContent } from "@openlup/platform/communications/contracts";

export type { ShipmentDispatchedEmailContent } from "@openlup/platform/communications/contracts";
export interface ShipmentDispatchedEmailVars extends Omit<NeutralShipmentDispatchedEmailVars, "contextName"> {
  petName?: string | null;
}
const content = createShipmentDispatchedContentFactory({ commerceEmailContent, formatCustomerOrderReference });
export function shipmentDispatchedEmailContent(locale: Locale, vars: ShipmentDispatchedEmailVars, signoff: string): ShipmentDispatchedEmailContent {
  return content.shipmentDispatchedEmailContent(locale, { ...vars, contextName: vars.petName }, signoff);
}

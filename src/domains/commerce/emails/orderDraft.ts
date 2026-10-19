import { createOrderDraftContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { OrderDraftEmailVars as NeutralOrderDraftEmailVars } from "@openlup/platform/communications/contracts";
import type { OrderDraftEmailContent } from "@openlup/platform/communications/contracts";

export type { OrderDraftLineItem, OrderDraftTotals, OrderDraftEmailContent } from "@openlup/platform/communications/contracts";
export interface OrderDraftEmailVars extends Omit<NeutralOrderDraftEmailVars, "contextName"> {
  petName?: string | null;
}
const content = createOrderDraftContentFactory({ commerceEmailContent, formatCustomerOrderReference });
export function orderDraftEmailContent(locale: Locale, vars: OrderDraftEmailVars, signoff: string): OrderDraftEmailContent {
  return content.orderDraftEmailContent(locale, { ...vars, contextName: vars.petName }, signoff);
}

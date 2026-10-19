import { createOrderPaidContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { OrderPaidEmailVars as NeutralOrderPaidEmailVars } from "@openlup/platform/communications/contracts";
import type { OrderPaidEmailContent } from "@openlup/platform/communications/contracts";

export type { OrderPaidLineItem, OrderPaidTotals, OrderPaidEmailContent } from "@openlup/platform/communications/contracts";
export interface OrderPaidEmailVars extends Omit<NeutralOrderPaidEmailVars, "contextName"> {
  petName?: string | null;
}
const content = createOrderPaidContentFactory({ commerceEmailContent, formatCustomerOrderReference });
export function orderPaidEmailContent(locale: Locale, vars: OrderPaidEmailVars, signoff: string): OrderPaidEmailContent {
  return content.orderPaidEmailContent(locale, { ...vars, contextName: vars.petName }, signoff);
}

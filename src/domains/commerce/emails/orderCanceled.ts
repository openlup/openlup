import { createOrderCanceledContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { OrderCanceledEmailVars as NeutralOrderCanceledEmailVars } from "@openlup/platform/communications/contracts";
import type { OrderCanceledEmailContent } from "@openlup/platform/communications/contracts";

export type { OrderCanceledEmailContent } from "@openlup/platform/communications/contracts";
export interface OrderCanceledEmailVars extends Omit<NeutralOrderCanceledEmailVars, "contextName"> {
  petName?: string | null;
}
const content = createOrderCanceledContentFactory({ commerceEmailContent, formatCustomerOrderReference });
export function orderCanceledEmailContent(locale: Locale, vars: OrderCanceledEmailVars, signoff: string): OrderCanceledEmailContent {
  return content.orderCanceledEmailContent(locale, { ...vars, contextName: vars.petName }, signoff);
}

import { createCheckoutExpiredContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";

export type { CheckoutExpiredEmailVars, CheckoutExpiredEmailContent } from "@openlup/platform/communications/contracts";
export const { checkoutExpiredEmailContent } = createCheckoutExpiredContentFactory({ commerceEmailContent, formatCustomerOrderReference });

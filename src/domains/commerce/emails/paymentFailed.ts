import { createPaymentFailedContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";

export type { PaymentFailedEmailVars, PaymentFailedEmailContent } from "@openlup/platform/communications/contracts";
export const { paymentFailedEmailContent } = createPaymentFailedContentFactory({ commerceEmailContent, formatCustomerOrderReference });

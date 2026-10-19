import { createOrderRefundedContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";

export type { OrderRefundedEmailVars, OrderRefundedEmailContent } from "@openlup/platform/communications/contracts";
export const { orderRefundedEmailContent } = createOrderRefundedContentFactory({ commerceEmailContent, formatCustomerOrderReference });

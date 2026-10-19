import { createReturnEmailsContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";

export type { ReturnEmailVars, ReturnEmailContent } from "@openlup/platform/communications/contracts";
export const { returnApprovedEmailContent, returnRejectedEmailContent, returnRefundedEmailContent } = createReturnEmailsContentFactory({ commerceEmailContent, formatCustomerOrderReference });

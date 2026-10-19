import { createAbandonedCartContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

export type { AbandonedCartReminderHours, AbandonedCartEmailVars, AbandonedCartEmailContent } from "@openlup/platform/communications/contracts";
export const { abandonedCartEmailContent } = createAbandonedCartContentFactory({ commerceEmailContent, marketingUnsubscribeFooter });

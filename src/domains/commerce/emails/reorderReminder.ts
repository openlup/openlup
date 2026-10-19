import { createReorderReminderContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

export type { ReorderReminderEmailVars, ReorderReminderEmailContent } from "@openlup/platform/communications/contracts";
export const { reorderReminderEmailContent } = createReorderReminderContentFactory({ commerceEmailContent, marketingUnsubscribeFooter });

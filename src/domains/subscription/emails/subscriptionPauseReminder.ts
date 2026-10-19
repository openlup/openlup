import { createSubscriptionPauseReminderContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionPauseReminderEmailVars, SubscriptionPauseReminderEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionPauseReminderEmailContent } = createSubscriptionPauseReminderContentFactory({ subscriptionEmailContent });

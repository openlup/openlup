import { createSubscriptionRenewalUpcomingContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionRenewalUpcomingEmailVars, SubscriptionRenewalUpcomingEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionRenewalUpcomingEmailContent } = createSubscriptionRenewalUpcomingContentFactory({ subscriptionEmailContent });

import { createSubscriptionWelcomeContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionWelcomeEmailVars, SubscriptionWelcomeEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionWelcomeEmailContent } = createSubscriptionWelcomeContentFactory({ subscriptionEmailContent });

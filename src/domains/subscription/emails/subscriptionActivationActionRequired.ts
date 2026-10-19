import { createSubscriptionActivationActionRequiredContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionActivationActionRequiredVars } from "@openlup/platform/communications/contracts";
export const { subscriptionActivationActionRequiredEmailContent } = createSubscriptionActivationActionRequiredContentFactory({ subscriptionEmailContent });

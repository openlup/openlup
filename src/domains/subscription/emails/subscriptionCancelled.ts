import { createSubscriptionCancelledContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionCancelledEmailVars, SubscriptionCancelledEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionCancelledEmailContent } = createSubscriptionCancelledContentFactory({ subscriptionEmailContent });

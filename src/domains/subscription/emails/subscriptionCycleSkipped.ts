import { createSubscriptionCycleSkippedContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionCycleSkippedEmailVars, SubscriptionCycleSkippedEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionCycleSkippedEmailContent } = createSubscriptionCycleSkippedContentFactory({ subscriptionEmailContent });

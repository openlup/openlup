import { createSubscriptionResumedContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionResumedEmailVars, SubscriptionResumedEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionResumedEmailContent } = createSubscriptionResumedContentFactory({ subscriptionEmailContent });

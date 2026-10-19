import { createSubscriptionPausedContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionPausedEmailVars, SubscriptionPausedEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionPausedEmailContent } = createSubscriptionPausedContentFactory({ subscriptionEmailContent });

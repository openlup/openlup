import { createSubscriptionDeliveryRescheduledContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionDeliveryRescheduledEmailVars, SubscriptionDeliveryRescheduledEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionDeliveryRescheduledEmailContent } = createSubscriptionDeliveryRescheduledContentFactory({ subscriptionEmailContent });

import { createSubscriptionAddressChangedContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionAddressChangedEmailVars, SubscriptionAddressChangedEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionAddressChangedEmailContent } = createSubscriptionAddressChangedContentFactory({ subscriptionEmailContent });

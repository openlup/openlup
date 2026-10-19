import { createSubscriptionPackageChangedContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionPackageChangedEmailVars, SubscriptionPackageChangedEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionPackageChangedEmailContent } = createSubscriptionPackageChangedContentFactory({ subscriptionEmailContent });

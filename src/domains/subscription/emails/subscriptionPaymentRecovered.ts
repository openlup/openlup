import { createSubscriptionPaymentRecoveredContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionPaymentRecoveredEmailVars, SubscriptionPaymentRecoveredEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionPaymentRecoveredEmailContent } = createSubscriptionPaymentRecoveredContentFactory({ subscriptionEmailContent });

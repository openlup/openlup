import { createSubscriptionPaymentFailedContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
import { subscriptionPaymentCauseSentence } from "../subscriptionPaymentCauseCopy.js";
export type { SubscriptionPaymentFailedEmailVars, SubscriptionPaymentFailedEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionPaymentFailedEmailContent } = createSubscriptionPaymentFailedContentFactory({ subscriptionEmailContent, subscriptionPaymentCauseSentence });

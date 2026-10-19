import { createSubscriptionPaymentExpiredContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
import { subscriptionPaymentCauseSentence } from "../subscriptionPaymentCauseCopy.js";
export type { SubscriptionPaymentExpiredEmailVars, SubscriptionPaymentExpiredEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionPaymentExpiredEmailContent } = createSubscriptionPaymentExpiredContentFactory({ subscriptionEmailContent, subscriptionPaymentCauseSentence });

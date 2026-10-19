import { createSubscriptionRenewalAtRiskContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
import { subscriptionPaymentCauseSentence } from "../subscriptionPaymentCauseCopy.js";
export type { SubscriptionRenewalAtRiskCause, SubscriptionRenewalAtRiskEmailVars, SubscriptionRenewalAtRiskEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionRenewalAtRiskEmailContent } = createSubscriptionRenewalAtRiskContentFactory({ subscriptionEmailContent, subscriptionPaymentCauseSentence });

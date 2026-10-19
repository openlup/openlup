import { createSubscriptionWinbackContentFactory } from "@openlup/platform/communications/contracts";
import { subscriptionEmailContent } from "#subscription-email-content";
export type { SubscriptionWinbackEmailVars, SubscriptionWinbackEmailContent } from "@openlup/platform/communications/contracts";
export const { subscriptionWinbackEmailContent } = createSubscriptionWinbackContentFactory({ subscriptionEmailContent });

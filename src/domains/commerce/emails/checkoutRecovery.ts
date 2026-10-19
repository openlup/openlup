import { createCheckoutRecoveryContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";

export type { CheckoutRecoveryReminderHours, CheckoutRecoveryMode, CheckoutRecoveryEmailVars, CheckoutRecoveryEmailContent } from "@openlup/platform/communications/contracts";
export const { checkoutRecoveryEmailContent } = createCheckoutRecoveryContentFactory({ commerceEmailContent });

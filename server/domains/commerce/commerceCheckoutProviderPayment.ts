import { createCheckoutClientAction } from "@openlup/platform/commerce/server";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { PaymentExecutionProvider, PaymentProviderFlow } from "../../../src/domains/payment/types.js";
export { providerPayerFromRequest } from "@openlup/platform/commerce/server";
export const checkoutConfirmationProvider = "stripe" as const;
export const checkoutClientAction = createCheckoutClientAction(checkoutConfirmationProvider, "tpay");
export function providerFlowFor(
  paymentProvider: PaymentExecutionProvider,
  paymentExecution: CheckoutPaymentExecution | undefined,
): PaymentProviderFlow {
  if (paymentProvider === "tpay" && paymentExecution?.provider === "tpay") {
    if (paymentExecution.flow === "blik_recurring_saved") {
      return "recurring_charge";
    }
    return paymentExecution.flow;
  }
  return "one_time_payment";
}

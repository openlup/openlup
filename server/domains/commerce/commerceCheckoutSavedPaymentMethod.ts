import type { ResolvedSavedPaymentMethod, SavedPaymentMethodRecurringModel } from "./savedPaymentMethodResolverPort.js";
import { createCheckoutSavedPaymentMethodResolver } from "@openlup/platform/commerce/server";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
export type ResolveSavedTpayMethodResult = import("@openlup/platform/commerce/server").ResolveSavedMethodResult<ResolvedSavedPaymentMethod["providerAliasType"], SavedPaymentMethodRecurringModel>;
export const { resolveSavedPaymentMethodForCheckout: resolveSavedTpayPaymentMethodForCheckout } = createCheckoutSavedPaymentMethodResolver<CheckoutPaymentExecution, "blik_one_click" | "blik_recurring_saved", ResolvedSavedPaymentMethod["providerAliasType"], SavedPaymentMethodRecurringModel>(savedTpayMethodRequest);
function savedTpayMethodRequest(
  paymentExecution: CheckoutPaymentExecution | undefined,
): { flow: "blik_one_click" | "blik_recurring_saved"; savedMethodId: string } | null {
  if (paymentExecution?.provider !== "tpay") return null;
  if (
    paymentExecution.flow === "blik_one_click" ||
    paymentExecution.flow === "blik_recurring_saved"
  ) {
    return { flow: paymentExecution.flow, savedMethodId: paymentExecution.savedMethodId };
  }
  return null;
}

import type { CheckoutPaymentExecution } from "../../src/domains/commerce/paymentExecutionContracts.js";
import type { TpayTransientProviderInput } from "../../src/domains/payment/types.js";

/**
 * Maps the checkout's wire-level payment execution onto the adapter's transient
 * input.
 *
 * `blik_recurring_saved` and `blik_one_click` are checkout vocabulary only: both
 * charge an already-registered alias, which the adapter models as
 * `recurring_charge` / `blik_one_click` with the reference supplied separately.
 *
 * ⚠️ `recurringModel` is deliberately dropped for `blik_recurring_saved`: the
 * model belongs to the mandate that was registered, not to whatever the browser
 * asks for now, and the charge path reads it back from the stored consent. A
 * client-supplied model here would let the caller contradict the agreement the
 * payer actually gave.
 *
 * Single copy on purpose — this was previously duplicated byte-for-byte across
 * the checkout runtime and recovery-pay services, which is exactly the kind of
 * pair that drifts silently once one side gains a case.
 */
export function tpayTransientInput(
  execution: CheckoutPaymentExecution | undefined,
): TpayTransientProviderInput | null {
  if (execution?.provider !== "tpay") return null;
  if (execution.flow === "blik_recurring_saved") {
    return { provider: "tpay", flow: "recurring_charge" };
  }
  if (execution.flow === "blik_one_click") {
    return { provider: "tpay", flow: "blik_one_click" };
  }
  return execution;
}

import { createExpiredCheckoutRecoveryPolicy } from "@openlup/platform/commerce/server";
import { CHECKOUT_COMMAND_V1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
export { EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS, quotesMatchForRecovery } from "@openlup/platform/commerce/server";
export type { ExpiredRecoveryEligibility } from "@openlup/platform/commerce/server";
export const { classifyExpiredRecovery, classifyOrderRecoveryEligibility } = createExpiredCheckoutRecoveryPolicy<CheckoutRecoveryOrderSnapshot>({
  admitsSubscriptionSubject: order => !!order.petId || order.runtimeMetadata?.checkoutCommandVersion === CHECKOUT_COMMAND_V1,
});

export function quoteRequestForExpiredRecovery(order: CheckoutRecoveryOrderSnapshot): CreateQuoteRequest {
  if (!order.quoteSnapshot) throw new Error("expired_recovery_quote_snapshot_missing");
  const quote = order.quoteSnapshot.quote;
  const context = quote.context;
  return {
    mode: context?.mode ?? (order.mode === "subscription_cycle" ? "subscription" : "one_time"),
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      modeAtLine: context?.mode ?? (order.mode === "subscription_cycle" ? "subscription" : "one_time"),
    })),
    sizeConstraint: context?.sizeConstraint,
    cadenceDays: context?.cadenceDays ?? order.cadenceDays,
    promoCodes: context?.promoCodes ?? [],
    petId: order.petId,
    petProfileContext: context?.petProfileContext,
    customerEligibilityContext: order.customerEmail ? { email: order.customerEmail } : undefined,
  };
}

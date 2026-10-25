import type { CommerceFulfillmentEligibilityInput, OmsFulfillmentBlockReason } from "./contracts/state.js";

export function evaluateCommerceFulfillmentEligibility(
  input: CommerceFulfillmentEligibilityInput,
): { allowed: boolean; reason: OmsFulfillmentBlockReason | null } {
  if (input.activeHoldCount > 0) return { allowed: false, reason: "active_hold" };
  if (!input.hasShippingAddress) return { allowed: false, reason: "missing_shipping_address" };
  if (input.riskReviewRequired) return { allowed: false, reason: "risk_review" };
  if (!["paid", "fulfillment_pending", "fulfilled"].includes(input.orderStatus)) {
    return { allowed: false, reason: "order_not_paid" };
  }
  if (input.paymentStatus !== "succeeded") {
    return { allowed: false, reason: "payment_not_succeeded" };
  }
  if (input.orderMode === "subscription_cycle" && input.subscriptionCycleStatus !== "paid") {
    return { allowed: false, reason: "subscription_cycle_not_paid" };
  }
  if (
    input.inventoryReviewRequired ||
    ["missing", "released", "expired", "review_required"].includes(input.inventoryStatus ?? "not_checked")
  ) {
    return { allowed: false, reason: "inventory_review" };
  }
  return { allowed: true, reason: null };
}

export function mapOmsPaymentStatus(status: string | null): string {
  if (!status) return "not_started";
  if (status === "pending") return "processing";
  if (status === "paid") return "succeeded";
  return status as string;
}

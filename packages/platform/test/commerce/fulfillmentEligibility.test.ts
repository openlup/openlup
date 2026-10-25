import { expect, it } from "vitest";
import { evaluateCommerceFulfillmentEligibility, mapOmsPaymentStatus } from "../../src/commerce/index.js";
const allowed = { orderMode: "one_time" as const, orderStatus: "paid" as const, paymentStatus: "succeeded", activeHoldCount: 0, hasShippingAddress: true };
it("preserves fulfillment refusal precedence and subscription/inventory gates", () => {
  expect(evaluateCommerceFulfillmentEligibility(allowed)).toEqual({ allowed: true, reason: null });
  const cases = [
    [{ activeHoldCount: 1, hasShippingAddress: false }, "active_hold"],
    [{ hasShippingAddress: false, riskReviewRequired: true }, "missing_shipping_address"],
    [{ riskReviewRequired: true, orderStatus: "draft" }, "risk_review"],
    [{ orderStatus: "draft", paymentStatus: "failed" }, "order_not_paid"],
    [{ paymentStatus: "failed" }, "payment_not_succeeded"],
    [{ orderMode: "subscription_cycle", subscriptionCycleStatus: "pending" }, "subscription_cycle_not_paid"],
    [{ inventoryStatus: "released" }, "inventory_review"],
    [{ inventoryReviewRequired: true }, "inventory_review"],
  ] as const;
  for (const [patch, reason] of cases) expect(evaluateCommerceFulfillmentEligibility({ ...allowed, ...patch })).toEqual({ allowed: false, reason });
  expect(evaluateCommerceFulfillmentEligibility({ ...allowed, orderMode: "subscription_cycle", subscriptionCycleStatus: "paid", inventoryStatus: "reserved" }).allowed).toBe(true);
});
it("preserves legacy and unknown payment status mappings", () => {
  expect([null, "", "pending", "paid", "failed", "future_status"].map(mapOmsPaymentStatus))
    .toEqual(["not_started", "not_started", "processing", "succeeded", "failed", "future_status"]);
});

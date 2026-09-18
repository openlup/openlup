import { describe, expect, it } from "vitest";
import { PAYMENT_INTENT_STATUSES } from "@openlup/core/payment";
import { evaluateCommerceFulfillmentEligibility, mapOmsPaymentStatus } from "./types.js";

describe("commerce OMS fulfillment eligibility", () => {
  it("allows a paid one-time order with succeeded payment and no OMS blockers", () => {
    expect(
      evaluateCommerceFulfillmentEligibility({
        orderMode: "one_time",
        orderStatus: "paid",
        paymentStatus: "succeeded",
        activeHoldCount: 0,
        hasShippingAddress: true,
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it("blocks shipment for every payment-control status except succeeded", () => {
    for (const paymentStatus of [
      "not_started",
      "created",
      "requires_action",
      "processing",
      "failed",
      "expired",
      "cancelled",
      "refunded",
      "partially_refunded",
      "disputed",
    ] as const) {
      expect(
        evaluateCommerceFulfillmentEligibility({
          orderMode: "one_time",
          orderStatus: "paid",
          paymentStatus,
          activeHoldCount: 0,
          hasShippingAddress: true,
        }),
      ).toEqual({ allowed: false, reason: "payment_not_succeeded" });
    }
  });

  it("blocks active holds before payment and cycle checks", () => {
    expect(
      evaluateCommerceFulfillmentEligibility({
        orderMode: "subscription_cycle",
        orderStatus: "paid",
        paymentStatus: "succeeded",
        subscriptionCycleStatus: "paid",
        activeHoldCount: 1,
        hasShippingAddress: true,
      }),
    ).toEqual({ allowed: false, reason: "active_hold" });
  });

  it("blocks subscription-cycle shipment until the cycle is locally paid", () => {
    expect(
      evaluateCommerceFulfillmentEligibility({
        orderMode: "subscription_cycle",
        orderStatus: "paid",
        paymentStatus: "succeeded",
        subscriptionCycleStatus: "retry_scheduled",
        activeHoldCount: 0,
        hasShippingAddress: true,
      }),
    ).toEqual({ allowed: false, reason: "subscription_cycle_not_paid" });
  });

  it("blocks otherwise paid orders when OMS sees missing inventory reservation", () => {
    expect(
      evaluateCommerceFulfillmentEligibility({
        orderMode: "one_time",
        orderStatus: "paid",
        paymentStatus: "succeeded",
        activeHoldCount: 0,
        hasShippingAddress: true,
        inventoryStatus: "missing",
      }),
    ).toEqual({ allowed: false, reason: "inventory_review" });
  });
});

/**
 * `mapOmsPaymentStatus` had no test at all, and it ends in a bare cast:
 * `return status as OmsPaymentStatus`. The cast is not blind, but the reason it
 * is safe was never written down anywhere the reader could check — the argument
 * is always `commerce_payment_intents.status`, whose CHECK constraint admits
 * exactly `PAYMENT_INTENT_STATUSES`, and that equivalence is pinned in
 * `src/domains/payment/payment.test.ts`. These tests state the rest of the
 * mapping and the shape of the hole the cast leaves; `docs/PAYMENT_STATUS_CANON.md`
 * carries the argument in prose.
 */
describe("mapOmsPaymentStatus", () => {
  it("reports the absence of an intent as not_started rather than inventing one", () => {
    expect(mapOmsPaymentStatus(null)).toBe("not_started");
  });

  // The two aliases predate the payment-control plane: they are `commerce_payments`
  // vocabulary, and they are the whole reason this mapper exists rather than the
  // status being read straight through.
  it.each([
    ["pending", "processing"],
    ["paid", "succeeded"],
  ] as const)("translates the legacy payments alias %s to %s", (legacy, canonical) => {
    expect(mapOmsPaymentStatus(legacy)).toBe(canonical);
  });

  it("passes every canonical intent status through unchanged", () => {
    for (const status of PAYMENT_INTENT_STATUSES) {
      // `processing` and `succeeded` are also the two alias targets above, so a
      // mapper that translated in the wrong direction would fail here too.
      expect(mapOmsPaymentStatus(status)).toBe(status);
    }
  });

  it("does NOT validate: an unknown string is returned as if it were a status", () => {
    // Characterization, not endorsement. The bare cast is load-bearing on the
    // pinned intent-status CHECK, and this is the failure mode if a caller ever
    // feeds it something else. Tightening it is a behavior change and belongs to
    // whichever wave owns that caller.
    expect(mapOmsPaymentStatus("a_status_no_check_admits")).toBe("a_status_no_check_admits");
  });
});

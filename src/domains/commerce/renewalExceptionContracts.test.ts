import { describe, expect, it } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "./types";
import {
  adminCommerceRenewalExceptionsRequestSchema,
  adminCommerceRenewalExceptionsResponseSchema,
} from "./renewalExceptionContracts";

describe("renewal exception contracts", () => {
  it("defaults pagination and validates the read-only response envelope", () => {
    expect(adminCommerceRenewalExceptionsRequestSchema.parse({})).toEqual({
      page: 1,
      pageSize: 25,
      windowDays: 90,
    });
    expect(adminCommerceRenewalExceptionsRequestSchema.parse({ page: "2", pageSize: "10" })).toEqual({
      page: 2,
      pageSize: 10,
      windowDays: 90,
    });
    // The window is bounded on both ends: an unbounded one would let a caller
    // ask a read-only admin route for an arbitrarily long cohort scan.
    expect(adminCommerceRenewalExceptionsRequestSchema.parse({ windowDays: "30" }).windowDays).toBe(30);
    expect(adminCommerceRenewalExceptionsRequestSchema.safeParse({ windowDays: 0 }).success).toBe(false);
    expect(adminCommerceRenewalExceptionsRequestSchema.safeParse({ windowDays: 366 }).success).toBe(false);

    expect(adminCommerceRenewalExceptionsResponseSchema.parse({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      checkedAt: "2026-07-03T12:00:00.000Z",
      exceptions: [{
        dedupeKey: "renewal-exception:prepared_without_provider_ack:sub:cycle:intent:attempt",
        kind: "prepared_without_provider_ack",
        severity: "p1",
        owner: "commerce/payment",
        customerSafeStatus: "operator_review_required",
        operatorNextAction: "inspect_provider_before_retry",
        reason: "prepared_subscription_attempt_without_provider_ack",
        subscriptionId: "sub-1",
        subscriptionCycleId: "cycle-1",
        orderId: null,
        paymentIntentId: "intent-1",
        paymentAttemptId: "attempt-1",
        provider: "stripe",
        ageSeconds: 1900,
        observedAt: "2026-07-03T12:00:00.000Z",
        orderDetailPath: null,
        triageContext: triageContext(),
      }],
      summarySignals: [{
        kind: "due_cycle_without_order",
        count: 1,
        severity: "p1",
        owner: "commerce/subscription-support",
        customerSafeStatus: "operator_review_required",
        operatorNextAction: "inspect_subscription_scheduler",
        reason: "active_subscription_due_without_order_evidence",
      }],
      summaryCounts: {
        totalRows: 1,
        preparedWithoutProviderAck: 1,
        paidRenewalWithoutFulfillment: 0,
        dueCycleWithoutOrder: 1,
        paymentRows: 1,
        fulfillmentRows: 0,
        p0: 0,
        p1: 1,
        p2: 0,
        p3: 0,
      },
      totalCount: 1,
      page: 1,
      pageSize: 25,
    })).toMatchObject({ totalCount: 1 });
  });

  it("rejects mutation/provider secret fields", () => {
    const parsed = adminCommerceRenewalExceptionsResponseSchema.safeParse({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      checkedAt: "2026-07-03T12:00:00.000Z",
      exceptions: [{
        dedupeKey: "renewal-exception:x",
        kind: "prepared_without_provider_ack",
        severity: "p1",
        owner: "commerce/payment",
        customerSafeStatus: "operator_review_required",
        operatorNextAction: "inspect_provider_before_retry",
        reason: "prepared_subscription_attempt_without_provider_ack",
        subscriptionId: null,
        subscriptionCycleId: null,
        orderId: null,
        paymentIntentId: "intent-1",
        paymentAttemptId: "attempt-1",
        provider: "stripe",
        providerPaymentId: "pi_secret",
        applyResult: "retry_payment",
        ageSeconds: 1900,
        observedAt: "2026-07-03T12:00:00.000Z",
        orderDetailPath: null,
        triageContext: {
          ...triageContext(),
          providerPaymentId: "pi_secret",
        },
      }],
      summarySignals: [],
      summaryCounts: {
        totalRows: 1,
        preparedWithoutProviderAck: 1,
        paidRenewalWithoutFulfillment: 0,
        dueCycleWithoutOrder: 0,
        paymentRows: 1,
        fulfillmentRows: 0,
        p0: 0,
        p1: 1,
        p2: 0,
        p3: 0,
      },
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(parsed.success).toBe(false);
  });
});

function triageContext() {
  return {
    localPaymentStatus: "processing",
    subscriptionCycleStatus: null,
    orderStatus: null,
    outboxStatus: null,
    outboxAvailableAt: null,
    outboxAttempts: null,
    fulfillmentEligibilityReason: "payment_provider_ack_missing",
    fulfillmentRecoveryPosture: "not_retryable",
    lockedCycleSummary: null,
    futureTemplateSummary: null,
  };
}

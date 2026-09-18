import { describe, expect, it } from "vitest";
import type { OrderMoneyReconciliationSnapshot } from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";
import { summarizePromotionObservability } from "./promotionObservabilityEvidence.js";
import type { PromotionHealthRpcSnapshot } from "../../adapters/supabase/platform/promotionObservabilityRows.js";

const NOW = "2026-07-15T12:00:00.000Z";

describe("promotion observability evidence", () => {
  it("maps the bounded SQL snapshot without rerunning promotion policy", () => {
    const result = summarizePromotionObservability(observabilityInput(health()));

    expect(result.promotionHealth).toMatchObject({
      checkedClaimCount: 6,
      reservedCount: 2,
      redeemedCount: 3,
      releasedCount: 1,
      staleReservationCount: 1,
      staleBlockingCapacityCount: 1,
      capacityExcessCount: 1,
      latePaidCount24h: 1,
    });
    expect(result.promotionHealth.evidence.map((item) => item.kind)).toEqual([
      "global_capacity_excess",
      "stale_reservation",
      "late_paid",
    ]);
  });

  it("adds only RPC-confirmed persisted-money codes to the existing CODM evidence", () => {
    const input = health();
    input.moneyEvidence = [{
      orderId: "00000000-0000-4000-8000-000000000001",
      mismatchCodes: ["promotion_product_total", "promotion_product_floor"],
    }];
    input.aggregates.promotionMoneyMismatchCount = 1;

    const result = summarizePromotionObservability(observabilityInput(input));

    expect(result.orderMoneyReconciliation.evidence[0].mismatchCodes).toEqual([
      "promotion_product_total",
      "promotion_product_floor",
    ]);
    expect(result.orderMoneyReconciliation.mismatchCount).toBe(1);
    expect(result.promotionHealth.promotionMoneyMismatchCount).toBe(1);
  });

  it("cannot emit more than the closed RPC evidence contract", () => {
    const input = health();
    input.evidence = Array.from({ length: 100 }, (_, index) => ({
      kind: "stale_reserved" as const,
      claimId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      observedAt: NOW,
    }));
    expect(summarizePromotionObservability(observabilityInput(input))
      .promotionHealth.evidence).toHaveLength(100);
  });
});

function health(): PromotionHealthRpcSnapshot {
  return {
    contractVersion: "promotion-health.v1",
    historyCoverage: "post_migration_only",
    measuredAt: NOW,
    windowFrom: "2026-07-14T12:00:00.000Z",
    staleBefore: "2026-07-15T11:45:00.000Z",
    aggregates: {
      claims: { reserved: 2, redeemed: 3, released: 1, activeCapacity: 5, staleReserved: 1, staleBlockingCapacity: 1 },
      capacity: { definition: "reserved_plus_redeemed", configuredLimitCodes: 1, atLimitCodes: 0, overLimitCodes: 1 },
      lifecycleMismatchCount: 0,
      missingClaimOrderCount: 0,
      orphanClaimCount: 0,
      promotionMoneyMismatchCount: 0,
    },
    transitionCounts24h: { reserved: 1, redeemed: 1, released: 1, late_paid: 1 },
    evidence: [
      { kind: "capacity_exceeded", promotionCodeId: "00000000-0000-4000-8000-000000000010", scope: "global", count: 2, limit: 1, observedAt: NOW },
      { kind: "stale_reserved", claimId: "00000000-0000-4000-8000-000000000011", blockingCapacity: true, observedAt: NOW },
      { kind: "late_paid", claimId: "00000000-0000-4000-8000-000000000012", observedAt: NOW },
    ],
    moneyEvidence: [],
  };
}

function observabilityInput(healthSnapshot: PromotionHealthRpcSnapshot) {
  return {
    health: healthSnapshot,
    orderMoney: orderMoney(),
  };
}

function orderMoney(): OrderMoneyReconciliationSnapshot {
  return {
    checkedCount: 1,
    mismatchCount: 0,
    providerUnavailableCount: 0,
    providerUnsupportedCount: 0,
    providerPendingCount: 0,
    providerOverdueCount: 0,
    providerEventMoneyUnavailableCount: 0,
    byMode: {
      one_time: { checkedCount: 1, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
      subscription_initial: { checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
      subscription_renewal: { checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
    },
    evidence: [{
      orderId: "00000000-0000-4000-8000-000000000001",
      orderRef: "V-1",
      mode: "one_time",
      paymentProvider: null,
      subscriptionCycleId: null,
      mismatchCodes: [],
      order: { id: "order-1", amountCents: 2_000, currency: "PLN", subtotalCents: 10_000, discountCents: 8_000, shippingCents: 0, shippingDiscountCents: 0, taxCents: 0, netCents: 2_000 },
      intent: null,
      attempt: null,
      providerEvent: null,
      localSettlement: { state: "not_applicable", reason: "expected_provider_payment_ref_absent" },
      providerSettlement: { state: "not_applicable", reason: "expected_provider_payment_ref_absent" },
      invoice: null,
      fulfillment: { fulfillmentOrderIds: [], statuses: [], handedOverAt: null },
      invoiceExpectation: { issueTrigger: "paid", state: "not_due", anchorAt: null, dueAt: null },
      invoiceLineageIds: { rootInvoiceIds: [], invoiceIds: [], documentKeys: [], currentInvoiceId: null },
      disposition: "matched",
      relatedIds: { chargeIntentIds: [], succeededAttemptIds: [], trustedProviderEventIds: [], trustedProviderReconciliationIds: [], localSettlementIds: [], trustedProviderSettlementIds: [], baseInvoiceIds: [] },
      observedAt: NOW,
    }],
  };
}

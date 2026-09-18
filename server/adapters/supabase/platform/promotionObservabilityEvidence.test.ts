import { describe, expect, it, vi } from "vitest";
import type {
  AlertDecision,
  ObservabilitySnapshot,
} from "../../../../src/domains/platform/observabilityContracts.js";
import { collectOrderMoneyReconciliationAlerts } from "../../../../src/domains/platform/orderMoneyReconciliationEvaluator.js";
import { withPromotionObservabilityEvidence } from "./promotionObservabilityEvidence.js";
import type { PromotionHealthRpcSnapshot } from "./promotionObservabilityRows.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("promotion observability adapter", () => {
  it("keeps persisted v2 money integrity in CODM while aggregate health is disabled", async () => {
    const base = { collectSnapshot: vi.fn().mockResolvedValue(snapshot()) };
    const response = rpcResponse();
    response.aggregates.promotionMoneyMismatchCount = 1;
    response.moneyEvidence = [{
      orderId: "00000000-0000-4000-8000-000000000001",
      mismatchCodes: ["promotion_product_total"],
    }];
    const rpc = vi.fn().mockResolvedValue({ data: response, error: null });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await withPromotionObservabilityEvidence(base, { rpc } as never, controls(false))
      .collectSnapshot(NOW);

    expect(result.promotionHealth).toBeUndefined();
    expect(result.orderMoneyReconciliation?.mismatchCount).toBe(1);
    expect(result.orderMoneyReconciliation?.evidence[0]?.mismatchCodes)
      .toContain("promotion_product_total");
    const decisions: AlertDecision[] = [];
    collectOrderMoneyReconciliationAlerts(decisions, result.orderMoneyReconciliation);
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dedupeKey: "canonical_order_money_mismatch:00000000-0000-4000-8000-000000000001",
        severity: "p1",
      }),
    ]));
    expect(rpc).toHaveBeenCalledWith("commerce_promotion_health_snapshot", expect.objectContaining({
      p_include_health: false,
    }));
    expect(info).not.toHaveBeenCalled();
  });

  it("uses one bounded RPC and emits one aggregate-only health snapshot", async () => {
    const base = { collectSnapshot: vi.fn().mockResolvedValue(snapshot()) };
    const rpc = vi.fn().mockResolvedValue({ data: rpcResponse(), error: null });
    const from = vi.fn(() => { throw new Error("raw scan forbidden"); });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await withPromotionObservabilityEvidence(base, { rpc, from } as never, controls(true))
      .collectSnapshot(NOW);

    expect(rpc).toHaveBeenCalledOnce();
    expect(from).not.toHaveBeenCalled();
    expect(result.promotionHealth).toMatchObject({
      enabled: true,
      checkedClaimCount: 0,
      staleBlockingCapacityCount: 0,
    });
    expect(info).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).toContain("promotion_code_health_snapshot");
    expect(serialized).not.toMatch(/promotionAcceptanceToken|SAVE80|clientId|signature|visitor/i);
  });
});

function snapshot(): ObservabilitySnapshot {
  return {
    checkedAt: NOW.toISOString(),
    runtimeFlags: {},
    jobControls: [],
    recentJobRuns: [],
    queues: [],
    recipients: [],
    dunning: { overdueRetryCount: 0, expiredWithoutCustomerNoticeCount: 0, failureWithoutAdminAlertCount: 0, failedAdminNotificationCount: 0, skippedAdminNotificationCount: 0, expiredCount24h: 0, recoveredCount24h: 0 },
    subscriptions: { dueCycleWithoutOrderCount: 0, upcomingDeliveryReminderMissingCount: 0 },
    emails: { criticalFailedCount: 0, failedBySource: {}, customerTimelineFailedCount: 0, customerTimelineMissedCount: 0, customerTimelineOverdueCount: 0, failedByPurpose: {}, auditIncompleteCount: 0, previewProductionDomainLinkCount: 0, webhookGapCount: 0, communicationOutboxFailedCount: 0 },
    payments: { providerPaidLocalUnpaidCount: 0, localPaidProviderUnpaidCount: 0, webhookMissingCount: 0, stuckProcessingCount: 0, amountCurrencyMismatchCount: 0, signatureFailureCount: 0, recoveryRequiredWithoutLinkCount: 0, evidence: [] },
    accounting: { shippedWithoutInvoiceCount: 0, missingInvoiceHandoffs: [], pendingOutboxCount: 0, failedOutboxCount: 0, failedCorrectionOutboxCount: 0, ksefPendingTooLongCount: 0, ksefRejectedCount: 0, correctionKsefPendingTooLongCount: 0, correctionKsefRejectedCount: 0, b2cEmailFailedCount: 0 },
    omnipack: { dispatchFailureCount: 0, staleStockSyncCount: 0, actionableShortageEvidenceCount: 0, providerLowerMismatchCount: 0, providerHigherMismatchCount: 0, recentQuarantinedInboundCount: 0, latestStatusEvidenceAt: null, latestStockSyncAt: null },
    orderMoneyReconciliation: {
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
        orderRef: "OPENLUP-1",
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
        observedAt: NOW.toISOString(),
      }],
    },
  };
}

function rpcResponse(): PromotionHealthRpcSnapshot {
  return {
    contractVersion: "promotion-health.v1",
    historyCoverage: "post_migration_only",
    measuredAt: NOW.toISOString(),
    windowFrom: "2026-07-14T12:00:00.000Z",
    staleBefore: "2026-07-15T11:45:00.000Z",
    aggregates: {
      claims: { reserved: 0, redeemed: 0, released: 0, activeCapacity: 0, staleReserved: 0, staleBlockingCapacity: 0 },
      capacity: { definition: "reserved_plus_redeemed", configuredLimitCodes: 0, atLimitCodes: 0, overLimitCodes: 0 },
      lifecycleMismatchCount: 0,
      missingClaimOrderCount: 0,
      orphanClaimCount: 0,
      promotionMoneyMismatchCount: 0,
    },
    transitionCounts24h: { reserved: 0, redeemed: 0, released: 0, late_paid: 0 },
    evidence: [],
    moneyEvidence: [],
  };
}

function controls(healthEnabled: boolean) {
  return { healthEnabled };
}

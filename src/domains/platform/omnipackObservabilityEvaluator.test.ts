import { describe, expect, it } from "vitest";
import { JOB_CATALOG } from "./jobCatalog";
import { evaluateObservability } from "./observabilityEvaluator";
import type { ObservabilitySnapshot } from "./observabilityContracts";

const now = new Date("2026-06-10T12:00:00.000Z");

describe("Fulfillment provider observability evaluator", () => {
  it("registers all fulfillment provider jobs behind the observability flag", () => {
    const jobs = JOB_CATALOG.filter((job) => job.requiresFlag === "COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED");

    expect(jobs.map((job) => job.jobName)).toEqual([
      "omnipack-dispatch",
      "omnipack-reconciliation",
      "omnipack-stock-sync",
      "omnipack-product-sync",
    ]);
    expect(jobs.every((job) => job.runbookUrl.endsWith("/docs/platform/RUNTIME_AND_SELF_HOSTING.md"))).toBe(true);
  });

  it("keeps fulfillment provider alerts silent until observability is enabled", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: {
        ...snapshot().omnipack,
        dispatchFailureCount: 1,
        actionableShortageEvidenceCount: 1,
        reservationCoverageCount: 1,
        unknownStockSkuCount: 1,
      },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_dispatch_failed");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_low_stock");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_reservation_coverage");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_provider_stock_unclassified_sku");
  });

  it("does not alert merely because no global provider status evidence exists", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      omnipack: { ...snapshot().omnipack, latestStatusEvidenceAt: null },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_status_evidence_stale");
  });

  it("raises frozen-fulfillment alerts even while fulfillment observability is disabled", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: { ...snapshot().omnipack, frozenFulfillmentCount: 2 },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "omnipack_fulfillment_status_frozen");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ count: 2 });
    expect(decisions.map((d) => d.dedupeKey)).not.toContain("omnipack_fulfillment_label_created_frozen");
  });

  it("raises the label_created freeze at p2 so it lands in the ledger without paging", () => {
    // p2 is below DEFAULT_PAGING_MIN_SEVERITY ("p1"): the 72h SLA is a reasoned
    // guess and must not page until the real distribution is measured.
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: { ...snapshot().omnipack, frozenLabelCreatedCount: 3 },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "omnipack_fulfillment_label_created_frozen");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p2");
    expect(decision?.payload).toMatchObject({ count: 3 });
    expect(decisions.map((d) => d.dedupeKey)).not.toContain("omnipack_fulfillment_status_frozen");
  });

  it("raises handed-over-without-tracking-ref at p1 even while fulfillment observability is disabled", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: { ...snapshot().omnipack, handedOverWithoutTrackingRefCount: 1 },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "shipment_handed_over_without_tracking_ref");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ count: 1 });
  });

  it("stays silent when the new fulfillment counters are zero or absent", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      omnipack: { ...snapshot().omnipack, frozenLabelCreatedCount: 0 },
    }, JOB_CATALOG, now);

    expect(decisions.map((d) => d.dedupeKey)).not.toContain("omnipack_fulfillment_label_created_frozen");
    expect(decisions.map((d) => d.dedupeKey)).not.toContain("shipment_handed_over_without_tracking_ref");
  });

  it("raises fulfillment-health blocked-uncertain alerts even while fulfillment observability is disabled", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: {
        ...snapshot().omnipack,
        fulfillmentHealthAttentionCount: 1,
        fulfillmentHealthBlockedUncertainCount: 1,
        fulfillmentHealthOldestAgeSeconds: 3600,
        fulfillmentHealthEvidence: [{
          orderId: "order-1",
          fulfillmentOrderId: "ful-1",
          outboxEventId: "outbox-1",
          dispatchRefFulfillmentOrderId: "ful-1",
          latestEvidenceFulfillmentOrderId: null,
          healthStatus: "blocked_uncertain",
          attentionReasons: ["dispatch_ref_uncertain"],
          oldestAgeSeconds: 3600,
        }],
      },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "omnipack_fulfillment_blocked_uncertain");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({
      count: 1,
      oldestAgeSeconds: 3600,
      evidence: [expect.objectContaining({
        orderId: "order-1",
        fulfillmentOrderId: "ful-1",
        healthStatus: "blocked_uncertain",
      })],
    });
    expect(JSON.stringify(decision)).not.toContain("Authorization");
    expect(JSON.stringify(decision)).not.toContain("buyer@example.com");
  });

  it("raises fulfillment-health local-ahead alerts even while fulfillment observability is disabled", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: {
        ...snapshot().omnipack,
        fulfillmentHealthAttentionCount: 1,
        fulfillmentHealthLocalAheadCount: 1,
        fulfillmentHealthEvidence: [{
          orderId: "order-local-ahead",
          fulfillmentOrderId: "ful-local-ahead",
          outboxEventId: null,
          dispatchRefFulfillmentOrderId: null,
          latestEvidenceFulfillmentOrderId: "ful-local-ahead",
          healthStatus: "local_ahead",
          attentionReasons: ["local_status_ahead_of_provider"],
          oldestAgeSeconds: 7200,
        }],
      },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "omnipack_fulfillment_local_ahead");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({
      count: 1,
      oldestAgeSeconds: 7200,
      evidence: [expect.objectContaining({
        orderId: "order-local-ahead",
        fulfillmentOrderId: "ful-local-ahead",
        healthStatus: "local_ahead",
      })],
    });
  });

  it("raises provider-ahead alerts even while fulfillment observability is disabled", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: {
        ...snapshot().omnipack,
        fulfillmentHealthAttentionCount: 1,
        fulfillmentHealthProviderAheadCount: 1,
        fulfillmentHealthEvidence: [{
          orderId: "order-provider-ahead",
          fulfillmentOrderId: "ful-provider-ahead",
          outboxEventId: null,
          dispatchRefFulfillmentOrderId: "ful-provider-ahead",
          latestEvidenceFulfillmentOrderId: null,
          healthStatus: "provider_ahead",
          attentionReasons: ["provider_accepted_local_label_ack_missing"],
          oldestAgeSeconds: 301,
        }],
      },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "omnipack_fulfillment_provider_ahead");
    expect(decision).toMatchObject({
      severity: "p1",
      payload: {
        count: 1,
        oldestAgeSeconds: 301,
        evidence: [expect.objectContaining({
          orderId: "order-provider-ahead",
          healthStatus: "provider_ahead",
        })],
      },
    });
  });

  it("keeps fulfillment-health alerts silent when no order needs attention", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: {
        ...snapshot().omnipack,
        fulfillmentHealthAttentionCount: 0,
        fulfillmentHealthBlockedUncertainCount: 0,
        fulfillmentHealthLocalAheadCount: 0,
        fulfillmentHealthProviderAheadCount: 0,
        fulfillmentHealthEvidence: [],
      },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_fulfillment_blocked_uncertain");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_fulfillment_local_ahead");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_fulfillment_provider_ahead");
  });

  it("caps fulfillment-health alert evidence while preserving true counts", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      omnipack: {
        ...snapshot().omnipack,
        fulfillmentHealthAttentionCount: 12,
        fulfillmentHealthLocalAheadCount: 12,
        fulfillmentHealthEvidence: Array.from({ length: 12 }, (_, index) => ({
          orderId: `order-${index}`,
          fulfillmentOrderId: `ful-${index}`,
          outboxEventId: null,
          dispatchRefFulfillmentOrderId: null,
          latestEvidenceFulfillmentOrderId: `ful-${index}`,
          healthStatus: "local_ahead" as const,
          attentionReasons: ["local_status_ahead_of_provider"],
          oldestAgeSeconds: index,
        })),
      },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "omnipack_fulfillment_local_ahead");
    expect(decision?.payload).toMatchObject({ count: 12, oldestAgeSeconds: 11 });
    expect((decision?.payload?.evidence as unknown[] | undefined)?.length).toBe(10);
  });

  it("does not add a second pageable P1 for failed-ref health evidence", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      omnipack: {
        ...snapshot().omnipack,
        dispatchFailureCount: 1,
        fulfillmentHealthAttentionCount: 1,
        fulfillmentHealthNeedsAttentionCount: 1,
        fulfillmentHealthEvidence: [{
          orderId: "order-failed",
          fulfillmentOrderId: "ful-failed",
          outboxEventId: null,
          dispatchRefFulfillmentOrderId: "ful-failed",
          latestEvidenceFulfillmentOrderId: null,
          healthStatus: "needs_attention",
          attentionReasons: ["dispatch_ref_failed"],
          oldestAgeSeconds: 600,
        }],
      },
    }, JOB_CATALOG, now);

    expect(decisions.filter((decision) => [
      "omnipack_dispatch_failed",
      "omnipack_fulfillment_blocked_uncertain",
      "omnipack_provider_command_attention_required",
    ].includes(decision.dedupeKey))).toEqual([
      expect.objectContaining({ dedupeKey: "omnipack_dispatch_failed", severity: "p1" }),
    ]);
  });

  it("raises dispatch failures to p0 from the second one", () => {
    const one = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      omnipack: { ...snapshot().omnipack, dispatchFailureCount: 1 },
    }, JOB_CATALOG, now);
    expect(one.find((decision) => decision.dedupeKey === "omnipack_dispatch_failed")).toMatchObject({
      severity: "p1",
      payload: { count: 1 },
    });

    const two = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      omnipack: { ...snapshot().omnipack, dispatchFailureCount: 2 },
    }, JOB_CATALOG, now);
    expect(two.find((decision) => decision.dedupeKey === "omnipack_dispatch_failed")).toMatchObject({
      severity: "p0",
      payload: { count: 2 },
    });
  });

  it("raises support-safe fulfillment alerts from durable evidence counts", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      omnipack: {
        paidOrderMissingDispatchRefCount: 1,
        wrongFulfillmentProviderCount: 1,
        missingProviderOrderIdCount: 1,
        staleDispatchRefCount: 1,
        payloadMismatchCount: 1,
        dispatchFailureCount: 1,
        staleStockSyncCount: 1,
        actionableShortageEvidenceCount: 2,
        reservationCoverageCount: 3,
        reservationCoverageEvidence: [
          {
            sku: "OPENLUP-DOG-LAMB-CAN-400G",
            providerForSaleQuantity: 0,
            localAvailableQuantity: 0,
            firstSeenAt: "2026-06-10T07:00:00.000Z",
            lastSeenAt: "2026-06-10T08:00:00.000Z",
          },
          {
            sku: "OPENLUP-DOG-VENISON-CAN-400G",
            providerForSaleQuantity: 0,
            localAvailableQuantity: 0,
            firstSeenAt: "2026-06-10T07:00:00.000Z",
            lastSeenAt: "2026-06-10T08:00:00.000Z",
          },
        ],
        unknownStockSkuCount: 4,
        providerLowerMismatchCount: 3,
        providerHigherMismatchCount: 4,
        recentQuarantinedInboundCount: 5,
        reconciliationStateConflictCount: 1,
        latestStatusEvidenceAt: "2026-06-10T08:00:00.000Z",
        latestStockSyncAt: "2026-06-10T07:00:00.000Z",
      },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual(expect.arrayContaining([
      "omnipack_dispatch_failed",
      "omnipack_paid_order_missing_dispatch_ref",
      "omnipack_selected_wrong_fulfillment_provider",
      "omnipack_dispatch_missing_provider_order_id",
      "omnipack_payload_dictionary_mismatch",
      "omnipack_stock_sync_stale",
      "omnipack_low_stock",
      "omnipack_reservation_coverage",
      "omnipack_provider_stock_unclassified_sku",
      "omnipack_reconciliation_state_conflict",
      "omnipack_inbound_quarantined",
    ]));
    const pagingKeys = decisions.filter((decision) => decision.severity === "p0").map((decision) => decision.dedupeKey);
    expect(pagingKeys).toContain("omnipack_paid_order_missing_dispatch_ref");
    // Data integrity, not "not shipping": both demoted to p1 while the
    // paid-order-missing-dispatch-ref p0 stays.
    expect(pagingKeys).not.toContain("omnipack_selected_wrong_fulfillment_provider");
    expect(pagingKeys).not.toContain("omnipack_dispatch_missing_provider_order_id");
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_selected_wrong_fulfillment_provider")?.severity).toBe("p1");
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_dispatch_missing_provider_order_id")?.severity).toBe("p1");
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_reservation_coverage")?.severity).toBe("p1");
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_reservation_coverage")?.paging).toBeUndefined();
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_reservation_coverage")).toMatchObject({
      message: expect.stringContaining("OPENLUP-DOG-LAMB-CAN-400G"),
      payload: {
        count: 3,
        skus: ["OPENLUP-DOG-LAMB-CAN-400G", "OPENLUP-DOG-VENISON-CAN-400G"],
        evidence: expect.any(Array),
      },
      humanContext: {
        incidentClass: "data_integrity",
        firstAction: expect.stringContaining("snooze the alert to the agreed expiry"),
      },
    });
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_reservation_coverage")?.message)
      .toContain("(+1)");
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_provider_stock_unclassified_sku")).toMatchObject({
      severity: "p2",
      paging: "never",
      payload: { count: 4 },
    });
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_provider_stock_lower");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("omnipack_provider_stock_higher");
    expect(JSON.stringify(decisions)).not.toContain("Authorization");
    expect(JSON.stringify(decisions)).not.toContain("buyer@example.com");
  });

  it("links stale stock evidence to a failed job without a second page", () => {
    const stockJob = JOB_CATALOG.find((entry) => entry.jobName === "omnipack-stock-sync")!;
    const decisions = evaluateObservability({
      ...snapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: stockJob.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-10T06:00:00.000Z",
        lastStartedAt: "2026-06-10T08:55:00.000Z",
        lastFinishedAt: "2026-06-10T08:56:00.000Z",
        lastStatus: "failed",
        leaseUntil: null,
      }],
      omnipack: { ...snapshot().omnipack, staleStockSyncCount: 1 },
    }, [stockJob], now);

    expect(decisions.find((decision) => decision.dedupeKey === "job_failed:omnipack-stock-sync")).toBeDefined();
    expect(decisions.find((decision) => decision.dedupeKey === "omnipack_stock_sync_stale")).toMatchObject({
      severity: "p2",
      paging: "never",
      payload: {
        count: 1,
        rootAlertDedupeKey: "job_failed:omnipack-stock-sync",
      },
    });
  });
});

function snapshot(): ObservabilitySnapshot {
  return {
    checkedAt: now.toISOString(),
    runtimeFlags: {},
    jobControls: [],
    recentJobRuns: [],
    queues: [],
    recipients: [],
    dunning: {
      overdueRetryCount: 0,
      expiredWithoutCustomerNoticeCount: 0,
      failureWithoutAdminAlertCount: 0,
      failedAdminNotificationCount: 0,
      skippedAdminNotificationCount: 0,
      expiredCount24h: 0,
      recoveredCount24h: 0,
    },
    subscriptions: { dueCycleWithoutOrderCount: 0, upcomingDeliveryReminderMissingCount: 0 },
    emails: {
      criticalFailedCount: 0,
      failedBySource: {},
      customerTimelineFailedCount: 0,
      customerTimelineMissedCount: 0,
      customerTimelineOverdueCount: 0,
      failedByPurpose: {},
      auditIncompleteCount: 0,
      previewProductionDomainLinkCount: 0,
      webhookGapCount: 0,
      communicationOutboxFailedCount: 0,
    },
    payments: {
      providerPaidLocalUnpaidCount: 0,
      localPaidProviderUnpaidCount: 0,
      webhookMissingCount: 0,
      stuckProcessingCount: 0,
      amountCurrencyMismatchCount: 0,
      signatureFailureCount: 0,
      recoveryRequiredWithoutLinkCount: 0,
      evidence: [],
    },
    accounting: {
      shippedWithoutInvoiceCount: 0,
      missingInvoiceHandoffs: [],
      pendingOutboxCount: 0,
      failedOutboxCount: 0,
      failedCorrectionOutboxCount: 0,
      ksefPendingTooLongCount: 0,
      ksefRejectedCount: 0,
      correctionKsefPendingTooLongCount: 0,
      correctionKsefRejectedCount: 0,
      b2cEmailFailedCount: 0,
    },
    omnipack: {
      dispatchFailureCount: 0,
      staleStockSyncCount: 0,
      actionableShortageEvidenceCount: 0,
      providerLowerMismatchCount: 0,
      providerHigherMismatchCount: 0,
      recentQuarantinedInboundCount: 0,
      latestStatusEvidenceAt: null,
      latestStockSyncAt: null,
    },
  };
}

import { describe, expect, it } from "vitest";
import { summarizeOmniPackEvidence } from "./omnipackObservabilityEvidence.js";

const now = new Date("2026-06-10T12:00:00.000Z");

describe("Fulfillment provider observability evidence", () => {
  it("summarizes stale stock, reservation coverage, and unclassified provider stock", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [{ fulfillment_order_id: "ful-failed", status: "failed" }],
      fulfillmentOrders: [{ id: "ful-failed", order_id: "order-failed", status: "created" }],
      statusEvidence: [{ occurred_at: "2026-06-10T04:00:00.000Z" }],
      stockCursors: [{ status: "succeeded", last_stock_synced_at: "2026-06-10T08:00:00.000Z" }],
      stockSnapshots: [
        { sku: "OPENLUP-BEEF-2KG", mismatch_kind: "provider_lower", snapshot_at: "2026-06-10T08:00:00.000Z" },
        { sku: "OPENLUP-DUCK-2KG", mismatch_kind: "provider_higher", snapshot_at: "2026-06-10T08:05:00.000Z" },
        { sku: "OPENLUP-LAMB-2KG", mismatch_kind: "none", snapshot_at: "2026-06-10T08:10:00.000Z" },
      ],
      providerStockCurrent: [
        { sku: "OPENLUP-BEEF-2KG", inventory_class: "sellable", stale_after: "2026-06-10T18:00:00.000Z" },
        { sku: "UNKNOWN-1", inventory_class: null, stale_after: "2026-06-10T18:00:00.000Z" },
        { sku: "OLD-UNKNOWN", inventory_class: null, stale_after: "2026-06-10T11:59:59.000Z" },
      ],
      lowStockEvidence: [
        { status: "open", threshold_kind: "safety_stock", created_at: "2026-06-10T11:00:00.000Z" },
        {
          status: "open",
          threshold_kind: "reservation_coverage",
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          provider_for_sale_quantity: 0,
          local_available_quantity: 0,
          first_seen_at: "2026-06-10T12:00:00+02:00",
          last_seen_at: "2026-06-10T13:00:00+02:00",
        },
      ],
    });

    expect(summary).toMatchObject({
      dispatchFailureCount: 1,
      staleDispatchRefCount: 0,
      staleStockSyncCount: 1,
      actionableShortageEvidenceCount: 1,
      reservationCoverageCount: 1,
      reservationCoverageEvidence: [{
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        providerForSaleQuantity: 0,
        localAvailableQuantity: 0,
        firstSeenAt: "2026-06-10T10:00:00.000Z",
        lastSeenAt: "2026-06-10T11:00:00.000Z",
      }],
      unknownStockSkuCount: 1,
    });
    expect(summary).not.toHaveProperty("providerLowerMismatchCount");
    expect(summary).not.toHaveProperty("providerHigherMismatchCount");
  });

  it("keeps reservation evidence bounded and drops unsafe SKU values", () => {
    const lowStockEvidence = Array.from({ length: 12 }, (_, index) => ({
      status: "open",
      threshold_kind: "reservation_coverage",
      sku: index === 0 ? "buyer@example.com?token=secret" : `OPENLUP-SKU-${index}`,
      provider_for_sale_quantity: index,
      local_available_quantity: 0,
      first_seen_at: "2026-06-10T10:00:00.000Z",
      last_seen_at: `2026-06-10T11:${String(index).padStart(2, "0")}:00.000Z`,
    }));

    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      stockCursors: [],
      lowStockEvidence,
    });

    expect(summary.reservationCoverageCount).toBe(12);
    expect(summary.reservationCoverageEvidence).toHaveLength(10);
    expect(JSON.stringify(summary.reservationCoverageEvidence)).not.toContain("buyer@example.com");
    expect(JSON.stringify(summary.reservationCoverageEvidence)).not.toContain("token=secret");
  });

  it("does not create global status freshness evidence when there is no fulfillment provider movement", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      stockCursors: [{ status: "succeeded", last_stock_synced_at: "2026-06-10T11:00:00.000Z" }],
      stockSnapshots: [],
      lowStockEvidence: [],
    });

    expect(summary).not.toHaveProperty("staleStatusEvidenceCount");
    expect(summary.staleStockSyncCount).toBe(0);
  });

  it("counts actionable and reservation-coverage evidence independently of legacy mismatches", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [{ occurred_at: "2026-06-10T10:30:00.000Z" }],
      stockCursors: [{ status: "succeeded", last_stock_synced_at: "2026-06-10T11:00:00.000Z" }],
      stockSnapshots: [
        { sku: "OPENLUP-BEEF-2KG", mismatch_kind: "provider_lower", snapshot_at: "2026-06-10T08:00:00.000Z" },
        { sku: "OPENLUP-BEEF-2KG", mismatch_kind: "none", snapshot_at: "2026-06-10T11:00:00.000Z" },
        { sku: "OPENLUP-DUCK-2KG", mismatch_kind: "provider_higher", snapshot_at: "2026-06-10T11:00:00.000Z" },
      ],
      lowStockEvidence: [
        { status: "resolved", threshold_kind: "safety_stock", created_at: "2026-06-10T08:00:00.000Z" },
        { status: "acknowledged", threshold_kind: "safety_stock", created_at: "2026-06-10T11:00:00.000Z" },
        { status: "open", threshold_kind: "forecast", created_at: "2026-06-10T11:00:00.000Z" },
        { status: "open", threshold_kind: "manual", created_at: "2026-06-10T11:00:00.000Z" },
        { status: "open", threshold_kind: "provider_mismatch", created_at: "2026-06-10T11:00:00.000Z" },
        { status: "open", threshold_kind: "stale_sync", created_at: "2026-06-10T11:00:00.000Z" },
        { status: "acknowledged", threshold_kind: "reservation_coverage", created_at: "2026-06-10T11:00:00.000Z" },
        { status: "resolved", threshold_kind: "reservation_coverage", created_at: "2026-06-10T11:00:00.000Z" },
      ],
    });

    expect(summary.actionableShortageEvidenceCount).toBe(3);
    expect(summary.reservationCoverageCount).toBe(1);
    expect(summary).not.toHaveProperty("providerLowerMismatchCount");
    expect(summary).not.toHaveProperty("providerHigherMismatchCount");
  });

  it("counts only fulfillment provider quarantined inbound events received in the last 24 hours", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      stockCursors: [],
      stockSnapshots: [],
      lowStockEvidence: [],
      inboundEvents: [
        { provider: "omnipack", processing_status: "ignored", received_at: "2026-06-10T11:00:00.000Z" },
        {
          provider: "omnipack",
          processing_status: "ignored",
          received_at: "2026-06-10T11:30:00.000Z",
          error: { reason: "omnipack_reconciliation_state_conflict:commerce_fulfillment_not_found" },
        },
        { provider: "omnipack", processing_status: "ignored", received_at: "2026-06-09T11:59:59.000Z" },
        { provider: "stripe", processing_status: "ignored", received_at: "2026-06-10T11:00:00.000Z" },
        { provider: "omnipack", processing_status: "processed", received_at: "2026-06-10T11:00:00.000Z" },
      ],
    });

    expect(summary.recentQuarantinedInboundCount).toBe(1);
    expect(summary.reconciliationStateConflictCount).toBe(1);
  });

  it("uses the latest successful run count for the active conflict lifecycle", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      stockCursors: [],
      stockSnapshots: [],
      lowStockEvidence: [],
      reconciliationStateConflictCount: 0,
      inboundEvents: [{
        provider: "omnipack",
        processing_status: "ignored",
        received_at: "2026-06-10T11:30:00.000Z",
        error: { reason: "omnipack_reconciliation_state_conflict:commerce_fulfillment_not_found" },
      }],
    });

    expect(summary.recentQuarantinedInboundCount).toBe(0);
    expect(summary.reconciliationStateConflictCount).toBe(0);
  });

  it("summarizes paid-order dispatch proof gaps and payload dictionary mismatches", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [
        {
          fulfillment_order_id: "ful-1",
          status: "submitting",
          updated_at: "2026-06-10T10:00:00.000Z",
          sanitized_request: { carrier: "DHL", service: "DHL_COURIER_STANDARD", itemCount: 1 },
        },
        {
          fulfillment_order_id: "ful-2",
          status: "created",
          provider_order_id: null,
          updated_at: "2026-06-10T11:59:00.000Z",
          sanitized_request: { carrier: "INPOST", service: "INPOST_LOCKER_STANDARD", itemCount: 1 },
        },
        {
          fulfillment_order_id: "ful-3",
          status: "created",
          provider_order_id: "provider-order-3",
          updated_at: "2026-06-10T11:59:00.000Z",
          sanitized_request: { carrier: "DPD", service: "DPD_UNKNOWN", itemCount: 1 },
        },
      ],
      orders: [
        { id: "order-1", status: "paid", metadata: { selectedDelivery: { providerKind: "omnipack" } } },
        { id: "order-2", status: "fulfillment_pending", metadata: { selectedDelivery: { providerKind: "omnipack" } } },
        { id: "order-3", status: "paid", metadata: { selectedDelivery: { providerKind: "omnipack" } } },
      ],
      fulfillmentOrders: [
        { id: "ful-1", order_id: "order-1", provider_kind: "omnipack", status: "created" },
        { id: "ful-2", order_id: "order-2", provider_kind: "simulator", status: "created" },
        { id: "ful-3", order_id: "order-3", provider_kind: "omnipack", status: "created" },
      ],
      statusEvidence: [{ occurred_at: "2026-06-10T11:00:00.000Z" }],
      stockCursors: [{ status: "succeeded", last_stock_synced_at: "2026-06-10T11:00:00.000Z" }],
      stockSnapshots: [],
      lowStockEvidence: [],
    });

    expect(summary).toMatchObject({
      paidOrderMissingDispatchRefCount: 0,
      wrongFulfillmentProviderCount: 1,
      staleDispatchRefCount: 1,
      missingProviderOrderIdCount: 1,
      payloadMismatchCount: 1,
    });
  });

  it("counts fulfillment orders frozen mid-pipeline past the SLA", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      stockCursors: [],
      stockSnapshots: [],
      lowStockEvidence: [],
      fulfillmentOrders: [
        // Frozen: packed with no update for >6h.
        { id: "f-1", order_id: "o-1", status: "packed", updated_at: "2026-06-10T04:00:00.000Z" },
        // Frozen sibling: dispatch submitted, no label minted within the SLA.
        { id: "f-5", order_id: "o-5", status: "label_pending", updated_at: "2026-06-10T04:00:00.000Z" },
        // Fresh mid-pipeline row — not frozen.
        { id: "f-2", order_id: "o-2", status: "packed", updated_at: "2026-06-10T11:00:00.000Z" },
        // Terminal rows never count, however old.
        { id: "f-3", order_id: "o-3", status: "delivered", updated_at: "2026-06-01T00:00:00.000Z" },
        { id: "f-4", order_id: "o-4", status: "exception", updated_at: "2026-06-01T00:00:00.000Z" },
        // `created` is owned by the p0 missing-dispatch-ref detector.
        { id: "f-6", order_id: "o-6", status: "created", updated_at: "2026-06-01T00:00:00.000Z" },
      ],
    });

    expect(summary.frozenFulfillmentCount).toBe(2);
    expect(summary.frozenLabelCreatedCount).toBe(0);
  });

  it("keeps a label_created row silent inside the 72h cutoff so weekends do not page", () => {
    const summary = summarizeOmniPackEvidence({
      ...emptyEvidence(),
      // 8h old: a Friday-evening label is not collected until Monday morning.
      fulfillmentOrders: [
        { id: "f-1", order_id: "o-1", status: "label_created", updated_at: "2026-06-10T04:00:00.000Z" },
      ],
    });

    expect(summary.frozenLabelCreatedCount).toBe(0);
    expect(summary.frozenFulfillmentCount).toBe(0);
  });

  it("counts a label_created row past the 72h cutoff separately from the 6h frozen counter", () => {
    const summary = summarizeOmniPackEvidence({
      ...emptyEvidence(),
      fulfillmentOrders: [
        // 72h + 1m old.
        { id: "f-1", order_id: "o-1", status: "label_created", updated_at: "2026-06-07T11:59:00.000Z" },
        // 71h old — still inside the cutoff.
        { id: "f-2", order_id: "o-2", status: "label_created", updated_at: "2026-06-07T13:00:00.000Z" },
      ],
    });

    expect(summary.frozenLabelCreatedCount).toBe(1);
    expect(summary.frozenFulfillmentCount).toBe(0);
  });

  it("never counts provider-only status tokens that commerce_fulfillment_orders cannot hold", () => {
    // `provider_received` and `picking` are omnipack_status_evidence.local_status
    // values. The CHECK constraint on commerce_fulfillment_orders.status rejects
    // them, so a detector filtering on them covers nothing. Regression lock.
    for (const updatedAt of ["2026-06-10T11:59:00.000Z", "2026-06-10T04:00:00.000Z", "2026-01-01T00:00:00.000Z"]) {
      const summary = summarizeOmniPackEvidence({
        ...emptyEvidence(),
        fulfillmentOrders: [
          { id: "f-1", order_id: "o-1", status: "provider_received", updated_at: updatedAt },
          { id: "f-2", order_id: "o-2", status: "picking", updated_at: updatedAt },
        ],
      });

      expect(summary.frozenFulfillmentCount).toBe(0);
      expect(summary.frozenLabelCreatedCount).toBe(0);
    }
  });

  it("classifies direct dispatch refs without populating legacy provider-command fields", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [
        {
          fulfillment_order_id: "ful-stale-submitting",
          status: "submitting",
          updated_at: "2026-06-10T11:54:59.000Z",
        },
        {
          fulfillment_order_id: "ful-fresh-submitting",
          status: "submitting",
          updated_at: "2026-06-10T11:55:00.000Z",
        },
        {
          fulfillment_order_id: "ful-uncertain",
          status: "uncertain",
          updated_at: "2026-06-10T11:40:00.000Z",
        },
        {
          fulfillment_order_id: "ful-failed",
          status: "failed",
          updated_at: "2026-06-10T10:00:00.000Z",
        },
        {
          fulfillment_order_id: "ful-created-without-id",
          status: "created",
          provider_order_id: null,
          updated_at: "2026-06-10T11:50:00.000Z",
        },
        {
          fulfillment_order_id: "ful-created-with-id",
          status: "created",
          provider_order_id: "ext-order-1",
          updated_at: "2026-06-10T10:00:00.000Z",
        },
      ],
      statusEvidence: [],
      stockCursors: [],
      stockSnapshots: [],
      lowStockEvidence: [],
      orders: [
        paidOrder("order-missing-ref"),
        paidOrder("order-stale-submitting"),
        paidOrder("order-fresh-submitting"),
        paidOrder("order-uncertain"),
        paidOrder("order-failed"),
        paidOrder("order-created-without-id"),
        paidOrder("order-created-with-id"),
      ],
      fulfillmentOrders: [
        fulfillment("ful-missing-ref", "order-missing-ref"),
        fulfillment("ful-stale-submitting", "order-stale-submitting"),
        fulfillment("ful-fresh-submitting", "order-fresh-submitting"),
        fulfillment("ful-uncertain", "order-uncertain"),
        fulfillment("ful-failed", "order-failed"),
        fulfillment("ful-created-without-id", "order-created-without-id"),
        fulfillment("ful-created-with-id", "order-created-with-id", "label_created"),
      ],
    });

    expect(summary).toMatchObject({
      paidOrderMissingDispatchRefCount: 1,
      staleDispatchRefCount: 1,
      dispatchFailureCount: 1,
      missingProviderOrderIdCount: 1,
      fulfillmentHealthAttentionCount: 5,
      fulfillmentHealthMissingLocalCommitmentCount: 1,
      fulfillmentHealthBlockedUncertainCount: 2,
      fulfillmentHealthLocalAheadCount: 0,
      fulfillmentHealthNeedsAttentionCount: 2,
      fulfillmentHealthProviderAheadCount: 0,
    });
    expect(summary.fulfillmentHealthEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: "order-stale-submitting",
        attentionReasons: ["dispatch_ref_stale_submitting"],
      }),
      expect.objectContaining({
        orderId: "order-uncertain",
        healthStatus: "blocked_uncertain",
        attentionReasons: ["dispatch_ref_uncertain"],
      }),
      expect.objectContaining({
        orderId: "order-failed",
        attentionReasons: ["dispatch_ref_failed"],
      }),
      expect.objectContaining({
        orderId: "order-created-without-id",
        attentionReasons: ["dispatch_ref_created_without_provider_order_id"],
      }),
    ]));
    expect(summary).not.toHaveProperty("providerCommandAttentionCount");
    expect(summary).not.toHaveProperty("providerCommandUncertainCount");
    expect(summary).not.toHaveProperty("providerCommandStaleSubmittingCount");
    expect(summary).not.toHaveProperty("providerCommandEvidence");
  });

  it("surfaces local-ahead and provider-ahead evidence with opaque IDs only", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [
        {
          fulfillment_order_id: "ful-provider-ahead",
          provider_order_id: "ext-order-provider-ahead",
          status: "created",
          updated_at: "2026-06-10T11:54:59.000Z",
        },
        {
          fulfillment_order_id: "ful-acknowledged",
          provider_order_id: "ext-order-acknowledged",
          status: "created",
          updated_at: "2026-06-10T10:00:00.000Z",
        },
        {
          fulfillment_order_id: "ful-local-ahead",
          provider_order_id: "ext-order-local-ahead",
          status: "created",
          updated_at: "2026-06-10T09:30:00.000Z",
        },
      ],
      statusEvidence: [{
        fulfillment_order_id: "ful-local-ahead",
        local_status: "provider_received",
        occurred_at: "2026-06-10T10:00:00.000Z",
      }],
      stockCursors: [],
      stockSnapshots: [],
      lowStockEvidence: [],
      orders: [
        paidOrder("order-provider-ahead"),
        paidOrder("order-acknowledged"),
        paidOrder("order-local-ahead"),
      ],
      fulfillmentOrders: [
        fulfillment("ful-provider-ahead", "order-provider-ahead"),
        fulfillment("ful-acknowledged", "order-acknowledged", "label_created"),
        fulfillment("ful-local-ahead", "order-local-ahead", "handed_over"),
      ],
    });

    expect(summary.fulfillmentHealthAttentionCount).toBe(2);
    expect(summary.fulfillmentHealthBlockedUncertainCount).toBe(0);
    expect(summary.fulfillmentHealthLocalAheadCount).toBe(1);
    expect(summary.fulfillmentHealthProviderAheadCount).toBe(1);
    expect(summary.fulfillmentHealthOldestAgeSeconds).toBe(7200);
    expect(summary.fulfillmentHealthEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: "order-provider-ahead",
        fulfillmentOrderId: "ful-provider-ahead",
        healthStatus: "provider_ahead",
        attentionReasons: ["provider_accepted_local_label_ack_missing"],
        oldestAgeSeconds: 301,
      }),
      expect.objectContaining({
        orderId: "order-local-ahead",
        fulfillmentOrderId: "ful-local-ahead",
        latestEvidenceFulfillmentOrderId: "ful-local-ahead",
        healthStatus: "local_ahead",
        attentionReasons: ["local_status_ahead_of_provider"],
        oldestAgeSeconds: 7200,
      }),
    ]));
    expect(summary.fulfillmentHealthEvidence?.every((row) => !("providerCommandId" in row))).toBe(true);
    expect(JSON.stringify(summary.fulfillmentHealthEvidence)).not.toMatch(/buyer@example.com|authorization|secret|raw/i);
  });

  it("keeps fulfillment-health attention empty for an empty system", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      stockCursors: [],
      stockSnapshots: [],
      lowStockEvidence: [],
      orders: [],
      fulfillmentOrders: [],
    });

    expect(summary.fulfillmentHealthAttentionCount).toBe(0);
    expect(summary.fulfillmentHealthBlockedUncertainCount).toBe(0);
    expect(summary.fulfillmentHealthLocalAheadCount).toBe(0);
    expect(summary.fulfillmentHealthProviderAheadCount).toBe(0);
    expect(summary.fulfillmentHealthEvidence).toEqual([]);
  });

  it("counts paid fulfillment provider orders with no dispatch ref", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      dispatchRefs: [],
      orders: [
        { id: "order-1", status: "paid", metadata: { selectedDelivery: { providerKind: "omnipack" } } },
      ],
      fulfillmentOrders: [{ id: "ful-1", order_id: "order-1", provider_kind: "omnipack" }],
      statusEvidence: [{ occurred_at: "2026-06-10T11:00:00.000Z" }],
      stockCursors: [{ status: "succeeded", last_stock_synced_at: "2026-06-10T11:00:00.000Z" }],
      stockSnapshots: [],
      lowStockEvidence: [],
    });

    expect(summary.paidOrderMissingDispatchRefCount).toBe(1);
  });

  it("uses the newest fulfillment and latest ref so historical failures cannot mask or page current work", () => {
    const summary = summarizeOmniPackEvidence({
      now,
      orders: [paidOrder("order-retry")],
      fulfillmentOrders: [
        fulfillment("ful-old", "order-retry", "created"),
        { ...fulfillment("ful-new", "order-retry", "created"), updated_at: "2026-06-10T11:00:00.000Z" },
      ],
      dispatchRefs: [{
        fulfillment_order_id: "ful-old",
        status: "failed",
        updated_at: "2026-06-10T10:30:00.000Z",
      }],
      statusEvidence: [],
      stockCursors: [],
      lowStockEvidence: [],
    });

    expect(summary.paidOrderMissingDispatchRefCount).toBe(1);
    expect(summary.dispatchFailureCount).toBe(0);
  });
});

function emptyEvidence() {
  return {
    now,
    dispatchRefs: [],
    statusEvidence: [],
    stockCursors: [],
    stockSnapshots: [],
    lowStockEvidence: [],
  };
}

function paidOrder(id: string) {
  return {
    id,
    status: "paid",
    updated_at: "2026-06-10T10:00:00.000Z",
    metadata: {
      selectedDelivery: { providerKind: "omnipack" },
      customerEmail: "buyer@example.com",
    },
  };
}

function fulfillment(id: string, orderId: string, status = "created") {
  return {
    id,
    order_id: orderId,
    provider_kind: "omnipack",
    status,
    updated_at: "2026-06-10T10:00:00.000Z",
  };
}

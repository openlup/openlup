import { describe, expect, it, vi } from "vitest";
import type { ObservabilitySnapshot } from "../../../../src/domains/platform/observabilityContracts.js";
import { withShipmentTrackingRefEvidence } from "./shipmentTrackingRefEvidenceAdapter.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");

describe("shipment tracking ref evidence adapter", () => {
  it("merges only its own key and passes the base snapshot through untouched", async () => {
    const mutations: string[] = [];
    const reads: string[] = [];
    const baseSnapshot = baseSnapshotWithEvidence();
    const base = { collectSnapshot: vi.fn().mockResolvedValue(baseSnapshot) };

    const snapshot = await withShipmentTrackingRefEvidence(
      base,
      fakeClient(tables(), mutations, reads) as never,
    ).collectSnapshot(NOW);

    expect(base.collectSnapshot).toHaveBeenCalledTimes(1);
    expect(base.collectSnapshot).toHaveBeenCalledWith(NOW);
    expect(reads).toEqual([
      "commerce_fulfillment_orders",
      "shipment_external_refs",
      "omnipack_status_evidence",
    ]);
    expect(snapshot.omnipack.handedOverWithoutTrackingRefCount).toBe(1);
    expect({ ...snapshot, omnipack: undefined }).toEqual({ ...baseSnapshot, omnipack: undefined });
    expect(snapshot.omnipack).toEqual({
      ...baseSnapshot.omnipack,
      handedOverWithoutTrackingRefCount: 1,
    });
    expect(mutations).toEqual([]);
  });

  it("reports zero and skips both follow-up reads when nothing is handed over", async () => {
    const reads: string[] = [];
    const base = { collectSnapshot: vi.fn().mockResolvedValue(baseSnapshotWithEvidence()) };

    const snapshot = await withShipmentTrackingRefEvidence(
      base,
      fakeClient({ commerce_fulfillment_orders: [] }, [], reads) as never,
    ).collectSnapshot(NOW);

    expect(snapshot.omnipack.handedOverWithoutTrackingRefCount).toBe(0);
    expect(reads).toEqual(["commerce_fulfillment_orders"]);
  });
});

function tables(): Record<string, Array<Record<string, unknown>>> {
  return {
    commerce_fulfillment_orders: [
      // Handed over 2h ago with an active ref — covered, not counted.
      {
        id: "f-1",
        order_id: "o-1",
        status: "handed_over",
        handed_over_at: "2026-06-10T10:00:00.000Z",
        updated_at: "2026-06-10T10:00:00.000Z",
      },
      // Handed over 2h ago with no ref at all — the customer-visible failure.
      {
        id: "f-2",
        order_id: "o-2",
        status: "handed_over",
        handed_over_at: "2026-06-10T10:00:00.000Z",
        updated_at: "2026-06-10T10:00:00.000Z",
      },
      // Not selected by the query at all.
      {
        id: "f-3",
        order_id: "o-3",
        status: "delivered",
        handed_over_at: "2026-06-01T10:00:00.000Z",
        updated_at: "2026-06-01T10:00:00.000Z",
      },
      // Delivered-first: no ref, but the provider already reported DELIVERED,
      // so the emitter suppresses the dispatched email and nothing is owed.
      {
        id: "f-4",
        order_id: "o-4",
        status: "handed_over",
        handed_over_at: "2026-06-10T10:00:00.000Z",
        updated_at: "2026-06-10T10:00:00.000Z",
      },
    ],
    shipment_external_refs: [
      { order_id: "o-1", active: true },
      { order_id: "o-2", active: false },
      { order_id: "o-3", active: true },
    ],
    omnipack_status_evidence: [
      { fulfillment_order_id: "f-2", local_status: "in_transit" },
      { fulfillment_order_id: "f-4", local_status: "DELIVERED" },
    ],
  };
}

function fakeClient(
  source: Record<string, Array<Record<string, unknown>>>,
  mutations: string[],
  reads: string[] = [],
) {
  return {
    from(table: string) {
      reads.push(table);
      return query(source[table] ?? [], table, mutations);
    },
  };
}

function query(source: Array<Record<string, unknown>>, table: string, mutations: string[]) {
  let rows = [...source];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      rows = rows.filter((row) => row[column] === value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      rows = rows.filter((row) => values.includes(row[column]));
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    insert: () => recordMutation("insert"),
    update: () => recordMutation("update"),
    upsert: () => recordMutation("upsert"),
    delete: () => recordMutation("delete"),
    then(resolve: (value: { data: typeof rows; error: null }) => void) {
      resolve({ data: rows, error: null });
    },
  };
  function recordMutation(operation: string) {
    mutations.push(`${table}.${operation}`);
    return builder;
  }
  return builder;
}

function baseSnapshotWithEvidence(): ObservabilitySnapshot {
  return {
    checkedAt: NOW.toISOString(),
    runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
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
      recentQuarantinedInboundCount: 0,
      frozenFulfillmentCount: 3,
      frozenLabelCreatedCount: 2,
      latestStatusEvidenceAt: "2026-06-10T11:00:00.000Z",
      latestStockSyncAt: "2026-06-10T11:30:00.000Z",
    },
  };
}

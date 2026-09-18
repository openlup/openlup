import { describe, expect, it, vi } from "vitest";
import type { ObservabilitySnapshot } from "../../../../src/domains/platform/observabilityContracts.js";
import { withOrderMoneyReconciliationEvidence } from "./orderMoneyReconciliationEvidence.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");

describe("order money reconciliation evidence adapter", () => {
  it("composes the base snapshot with read rows and the real summarizer without mutations", async () => {
    const mutations: string[] = [];
    const baseSnapshot = emptyBaseSnapshot();
    const base = { collectSnapshot: vi.fn().mockResolvedValue(baseSnapshot) };
    const client = fakeClient(healthyTables(), mutations);

    const snapshot = await withOrderMoneyReconciliationEvidence(base, client as never, { issueTrigger: "paid" })
      .collectSnapshot(NOW);

    expect(base.collectSnapshot).toHaveBeenCalledTimes(1);
    expect(base.collectSnapshot).toHaveBeenCalledWith(NOW);
    expect(snapshot.checkedAt).toBe(baseSnapshot.checkedAt);
    expect(snapshot.runtimeFlags).toEqual(baseSnapshot.runtimeFlags);
    expect(snapshot.orderMoneyReconciliation).toMatchObject({
      checkedCount: 1,
      mismatchCount: 0,
      providerUnavailableCount: 0,
      byMode: {
        one_time: { checkedCount: 1, mismatchCount: 0, providerUnavailableCount: 0 },
        subscription_initial: { checkedCount: 0 },
        subscription_renewal: { checkedCount: 0 },
      },
    });
    expect(snapshot.orderMoneyReconciliation?.evidence[0]).toMatchObject({
      orderId: "order-1",
      mode: "one_time",
      mismatchCodes: [],
      providerSettlement: { state: "matched", amountCents: 1_000, currency: "PLN" },
      invoiceExpectation: { issueTrigger: "paid", state: "required" },
      invoice: { amountCents: 1_000, netCents: 926, positionGrossCents: 1_000 },
    });
    expect(mutations).toEqual([]);
  });
});

function healthyTables(): Record<string, Array<Record<string, unknown>>> {
  return {
    commerce_orders: [{
      id: "order-1",
      order_number: "OPENLUP-ADAPTER-1",
      mode: "one_time",
      status: "paid",
      subtotal_cents: 1_000,
      discount_cents: 0,
      shipping_cents: 0,
      shipping_discount_cents: 0,
      tax_cents: 74,
      total_cents: 1_000,
      currency: "PLN",
      subscription_cycle_id: null,
      updated_at: "2026-07-14T11:00:00.000Z",
    }],
    commerce_order_items: [{
      id: "item-1",
      order_id: "order-1",
      allocation_ordinal: 1,
      quantity: 1,
      total_cents: 1_000,
      discount_allocated_cents: 0,
      effective_total_cents: 1_000,
      effective_net_cents: 926,
      vat_rate_bps: 800,
    }],
    commerce_payment_intents: [{
      id: "intent-1",
      order_id: "order-1",
      payment_id: "payment-1",
      status: "succeeded",
      amount_cents: 1_000,
      currency: "PLN",
      active_attempt_id: "attempt-1",
      provider_payment_id: "provider-payment-1",
      updated_at: "2026-07-14T11:00:00.000Z",
    }],
    commerce_payment_attempts: [{
      id: "attempt-1",
      created_at: "2026-07-14T10:55:00.000Z",
      updated_at: "2026-07-14T11:00:00.000Z",
      payment_intent_id: "intent-1",
      provider: "tpay",
      status: "succeeded",
      amount_cents: 1_000,
      currency: "PLN",
      provider_attempt_id: "provider-payment-1",
    }],
    inbound_provider_events: [{
      id: "event-1",
      created_at: "2026-07-14T11:00:00.000Z",
      provider: "tpay",
      provider_event_id: "provider-event-1",
      provider_payment_id: "provider-payment-1",
      payment_intent_id: "intent-1",
      payment_attempt_id: "attempt-1",
      event_type: "payment.succeeded",
      amount_cents: 1_000,
      currency: "PLN",
      signature_verified: true,
    }],
    payment_provider_settlement_items: [{
      id: "settlement-1",
      created_at: "2026-07-14T11:30:00.000Z",
      batch_id: "batch-1",
      provider_kind: "tpay",
      provider_payment_id: "provider-payment-1",
      payment_intent_id: "intent-1",
      payment_id: "payment-1",
      invoice_id: "invoice-1",
      status: "matched",
      gross_cents: 1_000,
      currency: "PLN",
      evidence: { providerReadbackSource: "provider_api" },
    }],
    accounting_invoices: [{
      id: "invoice-1",
      order_id: "order-1",
      invoice_ref: "OPENLUP-ADAPTER-1",
      status: "issued",
      correction_of_invoice_id: null,
      provider_kind: "fakturownia",
      provider_invoice_id: "provider-invoice-1",
      blocked_reason: null,
      total_gross_cents: 1_000,
      total_net_cents: 926,
      currency: "PLN",
      metadata: {},
      created_at: "2026-07-14T11:05:00.000Z",
      updated_at: "2026-07-14T11:05:00.000Z",
      ksef_status: "not_required",
      lines_snapshot: [{
        positionKind: "item",
        orderItemId: "item-1",
        allocationOrdinal: 1,
        name: "Adapter fixture",
        quantity: 1,
        catalogTotalGrossMinor: 1_000,
        discountAllocatedMinor: 0,
        unitGrossMinor: 1_000,
        unitNetMinor: 926,
        totalGrossMinor: 1_000,
        totalNetMinor: 926,
        vatRate: "8",
        vatRateBps: 800,
      }],
    }],
  };
}

function fakeClient(
  tables: Record<string, Array<Record<string, unknown>>>,
  mutations: string[],
) {
  return {
    from(table: string) {
      return query(tables[table] ?? [], table, mutations);
    },
  };
}

function query(source: Array<Record<string, unknown>>, table: string, mutations: string[]) {
  let rows = [...source];
  let range: [number, number] | null = null;
  const builder = {
    select: () => builder,
    in: (column: string, values: unknown[]) => {
      rows = rows.filter((row) => values.includes(row[column]));
      return builder;
    },
    not: (column: string, operator: string, value: unknown) => {
      if (operator === "is" && value === null) rows = rows.filter((row) => row[column] != null);
      return builder;
    },
    order: (column: string) => {
      rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])));
      return builder;
    },
    range: (from: number, to: number) => {
      range = [from, to];
      return builder;
    },
    insert: () => recordMutation("insert"),
    update: () => recordMutation("update"),
    upsert: () => recordMutation("upsert"),
    delete: () => recordMutation("delete"),
    then(resolve: (value: { data: typeof rows; error: null }) => void) {
      resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null });
    },
  };
  function recordMutation(operation: string) {
    mutations.push(`${table}.${operation}`);
    return builder;
  }
  return builder;
}

function emptyBaseSnapshot(): ObservabilitySnapshot {
  return {
    checkedAt: NOW.toISOString(),
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

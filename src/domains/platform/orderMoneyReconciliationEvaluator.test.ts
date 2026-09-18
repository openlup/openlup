import { describe, expect, it } from "vitest";
import type { AlertDecision } from "./observabilityContracts.js";
import { collectOrderMoneyReconciliationAlerts } from "./orderMoneyReconciliationEvaluator.js";
import type { OrderMoneyReconciliationSnapshot } from "./orderMoneyReconciliationContracts.js";
import { matchCanonicalMoneyLegacyException, type CanonicalMoneyLegacyException } from "./orderMoneyLegacyExceptions.js";

describe("canonical order money reconciliation alerts", () => {
  it("deduplicates confirmed mismatches and records unsupported settlement imports without paging", () => {
    const decisions: AlertDecision[] = [];
    collectOrderMoneyReconciliationAlerts(decisions, snapshot());

    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dedupeKey: "canonical_order_money_mismatch:order-1",
        severity: "p1",
        payload: expect.objectContaining({ orderId: "order-1", mismatchCodes: ["invoice_amount"] }),
      }),
      expect.objectContaining({
        dedupeKey: "canonical_order_money_settlement_unsupported:subscription_renewal",
        severity: "p3",
        paging: "never",
      }),
    ]));
  });

  it("records nullable provider-event money as a non-pageable diagnostic", () => {
    const input = snapshot();
    input.evidence[0].mismatchCodes = [];
    input.evidence[0].providerSettlement = { state: "matched", id: "settlement-1", amountCents: 10_000, currency: "PLN" };
    input.evidence[0].providerEvent = { state: "unavailable", id: "event-1", amountCents: null, currency: null };
    const decisions: AlertDecision[] = [];

    collectOrderMoneyReconciliationAlerts(decisions, input);

    expect(decisions).toEqual([
      expect.objectContaining({
        dedupeKey: "canonical_order_money_provider_event_unavailable:subscription_renewal",
        severity: "p2",
        paging: "never",
      }),
    ]);
  });

  it("keeps pending silent and overdue settlement evidence non-pageable", () => {
    const input = snapshot();
    input.evidence[0].mismatchCodes = [];
    input.evidence[0].disposition = "matched";
    input.evidence[0].paymentProvider = "stripe";
    input.evidence[0].providerSettlement = { state: "pending", reason: "trusted_provider_settlement_pending" };
    const pending: AlertDecision[] = [];

    collectOrderMoneyReconciliationAlerts(pending, input);
    expect(pending).toEqual([]);

    input.evidence[0].providerSettlement = { state: "overdue", reason: "trusted_provider_settlement_overdue" };
    const overdue: AlertDecision[] = [];
    collectOrderMoneyReconciliationAlerts(overdue, input);
    expect(overdue).toEqual([expect.objectContaining({
      dedupeKey: "canonical_order_money_settlement_overdue:subscription_renewal",
      severity: "p2",
      paging: "never",
    })]);
  });

  it("does not page on a settlement status without a proved money or reference difference", () => {
    const input = snapshot();
    input.evidence[0].mismatchCodes = ["provider_settlement_status"];
    input.evidence[0].providerSettlement = {
      state: "mismatch", id: "settlement-1", amountCents: 10_000, currency: "PLN",
    };
    const decisions: AlertDecision[] = [];

    collectOrderMoneyReconciliationAlerts(decisions, input);

    expect(decisions).toEqual([expect.objectContaining({
      dedupeKey: "canonical_order_money_settlement_status_review:subscription_renewal",
      severity: "p2",
      paging: "never",
    })]);
    expect(decisions.map((row) => row.dedupeKey)).not.toContain("canonical_order_money_mismatch:order-1");
  });

  it("leaves a handoff-owned missing invoice to the accounting recovery alert", () => {
    const input = snapshot();
    input.evidence[0].mismatchCodes = ["base_invoice_count"];
    input.evidence[0].disposition = "accounting_missing_invoice_owner";
    input.evidence[0].invoice = null;
    const decisions: AlertDecision[] = [];

    collectOrderMoneyReconciliationAlerts(decisions, input);

    expect(decisions.map((row) => row.dedupeKey)).not.toContain("canonical_order_money_mismatch:order-1");
  });

  it("downgrades only the exact audited corrected-reissue exception and fails closed on drift", () => {
    const input = snapshot();
    const evidence = input.evidence[0];
    evidence.orderId = SYNTHETIC_EXCEPTION.orderId;
    evidence.order.id = evidence.orderId;
    evidence.order.amountCents = 11_175;
    evidence.order.currency = SYNTHETIC_EXCEPTION.currency;
    evidence.mismatchCodes = ["invoice_net_amount", "invoice_positions_invalid"];
    evidence.invoiceLineageIds = {
      rootInvoiceIds: [SYNTHETIC_EXCEPTION.rootInvoiceId],
      invoiceIds: [
        SYNTHETIC_EXCEPTION.rootInvoiceId,
        SYNTHETIC_EXCEPTION.replacementInvoiceId,
      ],
      documentKeys: [],
      currentInvoiceId: SYNTHETIC_EXCEPTION.replacementInvoiceId,
    };
    evidence.disposition = "accepted_legacy_exception";
    const decisions: AlertDecision[] = [];

    const matcher = (candidate: Parameters<typeof matchCanonicalMoneyLegacyException>[0]) =>
      matchCanonicalMoneyLegacyException(candidate, [SYNTHETIC_EXCEPTION]);
    collectOrderMoneyReconciliationAlerts(decisions, input, matcher);

    expect(decisions).toContainEqual(expect.objectContaining({
      dedupeKey: `canonical_order_money_legacy_exception:${evidence.orderId}`,
      severity: "p3",
      paging: "never",
    }));

    evidence.order.currency = "EUR";
    const drifted: AlertDecision[] = [];
    collectOrderMoneyReconciliationAlerts(drifted, input, matcher);
    expect(drifted).toContainEqual(expect.objectContaining({
      dedupeKey: `canonical_order_money_mismatch:${evidence.orderId}`,
      severity: "p1",
    }));
  });
});

const SYNTHETIC_EXCEPTION: CanonicalMoneyLegacyException = {
  orderId: "11111111-1111-4111-8111-111111111111",
  rootInvoiceId: "22222222-2222-4222-8222-222222222222",
  replacementInvoiceId: "33333333-3333-4333-8333-333333333333",
  grossCents: 11_175,
  currency: "ZZZ",
  mismatchCodes: ["invoice_net_amount", "invoice_positions_invalid"],
  reason: "pre_canonical_corrected_reissue",
};

function snapshot(): OrderMoneyReconciliationSnapshot {
  const evidence = {
    orderId: "order-1",
    orderRef: "OPENLUP-1",
    mode: "subscription_renewal" as const,
    paymentProvider: "tpay",
    subscriptionCycleId: "cycle-2",
    mismatchCodes: ["invoice_amount" as const],
    order: {
      id: "order-1", amountCents: 10_000, currency: "PLN", subtotalCents: 10_000,
      discountCents: 1_000, shippingCents: 1_500, shippingDiscountCents: 500,
      taxCents: 741, netCents: 9_259,
    },
    intent: { id: "intent-1", amountCents: 10_000, currency: "PLN" },
    attempt: { id: "attempt-1", amountCents: 10_000, currency: "PLN" },
    providerEvent: { id: "event-1", amountCents: 10_000, currency: "PLN", state: "matched" as const },
    localSettlement: { state: "matched" as const, id: "settlement-1", amountCents: 10_000, currency: "PLN" },
    providerSettlement: { state: "unsupported" as const, reason: "provider_settlement_import_unsupported:tpay" },
    fulfillment: { fulfillmentOrderIds: [], statuses: [], handedOverAt: null },
    invoiceExpectation: { issueTrigger: "paid" as const, state: "required" as const, anchorAt: "2026-07-13T10:00:00.000Z", dueAt: "2026-07-13T11:00:00.000Z" },
    invoiceLineageIds: { rootInvoiceIds: ["invoice-1"], invoiceIds: ["invoice-1"], documentKeys: ["invoice:invoice-1"], currentInvoiceId: "invoice-1" },
    disposition: "mismatch" as const,
    invoice: { id: "invoice-1", amountCents: 9_999, currency: "PLN", netCents: 9_258, positionGrossCents: 9_999, positionNetCents: 9_258 },
    relatedIds: { chargeIntentIds: ["intent-1"], succeededAttemptIds: ["attempt-1"], trustedProviderEventIds: ["event-1"], trustedProviderReconciliationIds: [], localSettlementIds: ["settlement-1"], trustedProviderSettlementIds: [], baseInvoiceIds: ["invoice-1"] },
    observedAt: "2026-07-13T12:00:00.000Z",
  };
  return {
    checkedCount: 1,
    mismatchCount: 1,
    providerUnavailableCount: 1,
    providerUnsupportedCount: 1,
    providerPendingCount: 0,
    providerOverdueCount: 0,
    providerEventMoneyUnavailableCount: 0,
    byMode: {
      one_time: { checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
      subscription_initial: { checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
      subscription_renewal: { checkedCount: 1, mismatchCount: 1, providerUnavailableCount: 1, providerUnsupportedCount: 1, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
    },
    evidence: [evidence],
  };
}

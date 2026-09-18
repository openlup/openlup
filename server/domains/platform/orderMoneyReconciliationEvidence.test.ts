import { describe, expect, it } from "vitest";
import { summarizeOrderMoneyReconciliation } from "./orderMoneyReconciliationEvidence.js";
import type { OrderMoneyReconciliationRows } from "../../adapters/supabase/platform/orderMoneyReconciliationRows.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

describe("canonical order money reconciliation evidence", () => {
  it("proves a healthy paid order across every available ledger", () => {
    const snapshot = summarizeOrderMoneyReconciliation(fixture(), NOW);

    expect(snapshot).toMatchObject({
      checkedCount: 1,
      mismatchCount: 0,
      providerUnavailableCount: 0,
      byMode: {
        one_time: { checkedCount: 1, mismatchCount: 0, providerUnavailableCount: 0 },
        subscription_initial: { checkedCount: 0 },
        subscription_renewal: { checkedCount: 0 },
      },
    });
    expect(snapshot.evidence[0]).toMatchObject({
      mode: "one_time",
      mismatchCodes: [],
      order: { amountCents: 10_000, currency: "PLN" },
      localSettlement: { state: "matched", amountCents: 10_000, currency: "PLN" },
      providerSettlement: { state: "matched", amountCents: 10_000, currency: "PLN" },
      invoice: { amountCents: 10_000, positionGrossCents: 10_000, positionNetCents: 9_259 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
  });

  it("groups initial and renewal orders and exposes seeded amount, currency, invoice, and position drift", () => {
    const initial = fixture("initial");
    const renewal = fixture("renewal");
    renewal.intents[0].amount_cents = 9_999;
    renewal.intents[0].currency = "EUR";
    renewal.attempts[0].currency = "EUR";
    renewal.events[0].amount_cents = 9_998;
    renewal.events[0].currency = "EUR";
    renewal.settlements[0].gross_cents = 9_997;
    renewal.settlements[0].currency = "EUR";
    renewal.invoices[0].total_gross_cents = 9_996;
    renewal.invoices[0].currency = "EUR";
    renewal.invoices[0].lines_snapshot = canonicalPositions(8_000, 7_407, "item-renewal");

    const snapshot = summarizeOrderMoneyReconciliation(merge(initial, renewal), NOW);
    const evidence = snapshot.evidence.find((row) => row.mode === "subscription_renewal");

    expect(snapshot.byMode.subscription_initial.checkedCount).toBe(1);
    expect(snapshot.byMode.subscription_renewal.mismatchCount).toBe(1);
    expect(evidence?.mismatchCodes).toEqual(expect.arrayContaining([
      "intent_amount",
      "intent_currency",
      "attempt_currency",
      "provider_event_amount",
      "provider_event_currency",
      "provider_settlement_amount",
      "provider_settlement_currency",
      "invoice_amount",
      "invoice_currency",
      "invoice_positions_gross",
      "invoice_positions_net",
    ]));
  });

  it("classifies unsupported and pending settlement readback without inferring a mismatch", () => {
    const missing = fixture();
    missing.settlements = [];
    const unproved = fixture("initial");
    unproved.settlements[0].evidence = { source: "manual_entry" };
    const pending = fixture("renewal");
    pending.settlements[0].status = "bank_pending";

    const snapshots = [missing, unproved, pending]
      .map((rows) => summarizeOrderMoneyReconciliation(rows, NOW));

    expect(snapshots.reduce((sum, row) => sum + row.providerUnavailableCount, 0)).toBe(3);
    expect(snapshots.reduce((sum, row) => sum + row.mismatchCount, 0)).toBe(0);
    expect(snapshots.map((row) => row.evidence[0].providerSettlement)).toEqual([
      { state: "unsupported", reason: "provider_settlement_import_unsupported:tpay" },
      { state: "unsupported", reason: "provider_settlement_import_unsupported:tpay" },
      { state: "pending", reason: "trusted_provider_settlement_pending" },
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("manual_entry");
  });

  it("uses the newest import of the same provider payment without treating batch history as a duplicate settlement", () => {
    const rows = fixture();
    rows.settlements.unshift({
      ...rows.settlements[0],
      id: "settlement-older",
      batch_id: "batch-older",
      created_at: "2026-07-12T10:00:00.000Z",
      status: "bank_pending",
    });

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).not.toContain("provider_settlement_payment_ref");
    expect(evidence.providerSettlement).toMatchObject({ state: "matched", id: "settlement-one_time" });
  });

  it("reports confirmed money drift even while the linked settlement is bank-pending", () => {
    const rows = fixture();
    rows.settlements[0].status = "bank_pending";
    rows.settlements[0].gross_cents = 9_999;
    rows.settlements[0].currency = "EUR";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.providerSettlement).toMatchObject({ state: "mismatch", amountCents: 9_999, currency: "EUR" });
    expect(evidence.mismatchCodes).toEqual(expect.arrayContaining([
      "provider_settlement_amount",
      "provider_settlement_currency",
    ]));
  });

  it("ignores a settlement from an old failed attempt when the final provider payment is settled", () => {
    const rows = fixture();
    rows.settlements.unshift({
      ...rows.settlements[0],
      id: "settlement-old-failed-attempt",
      batch_id: "batch-old-attempt",
      provider_payment_id: "provider-payment-old-attempt",
      created_at: "2026-07-13T10:30:00.000Z",
      status: "mismatch",
    });

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).not.toContain("provider_settlement_payment_ref");
    expect(evidence.providerSettlement).toMatchObject({ state: "matched", id: "settlement-one_time" });
  });

  it("keeps old failed-attempt settlement history unavailable when final readback is absent", () => {
    const rows = fixture();
    rows.attempts.unshift({
      id: "attempt-old-failed",
      payment_intent_id: rows.intents[0].id,
      provider: "tpay",
      status: "failed",
      amount_cents: 10_000,
      currency: "PLN",
      provider_attempt_id: "provider-payment-old-failed",
    });
    rows.settlements[0].provider_payment_id = "provider-payment-old-failed";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).not.toContain("provider_settlement_payment_ref");
    expect(evidence.providerSettlement).toEqual({
      state: "unsupported",
      reason: "provider_settlement_import_unsupported:tpay",
    });
  });

  it("fails closed when settlement evidence exists only for a different provider payment", () => {
    const rows = fixture();
    rows.settlements[0].provider_payment_id = "provider-payment-wrong";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).toContain("provider_settlement_payment_ref");
    expect(evidence.providerSettlement.state).toBe("mismatch");
  });

  it("classifies nullable trusted provider-event money as unavailable instead of a confirmed mismatch", () => {
    const rows = fixture();
    rows.events[0].amount_cents = null;
    rows.events[0].currency = null;

    const snapshot = summarizeOrderMoneyReconciliation(rows, NOW);

    expect(snapshot.mismatchCount).toBe(0);
    expect(snapshot.providerEventMoneyUnavailableCount).toBe(1);
    expect(snapshot.evidence[0].providerEvent).toMatchObject({ state: "unavailable", amountCents: null, currency: null });
  });

  it.each([
    ["provider", (rows: OrderMoneyReconciliationRows) => { rows.events[0].provider = "stripe"; }, "provider_event_provider"],
    ["payment reference", (rows: OrderMoneyReconciliationRows) => { rows.events[0].provider_payment_id = "wrong-payment"; }, "provider_event_payment_ref"],
  ] as const)("rejects a signed success event linked to the wrong %s", (_label, mutate, code) => {
    const rows = fixture();
    mutate(rows);

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).toEqual(expect.arrayContaining([code, "trusted_provider_event_missing"]));
    expect(evidence.relatedIds.trustedProviderEventIds).toEqual([]);
  });

  it("reports a succeeded attempt whose provider reference differs from the intent", () => {
    const rows = fixture();
    rows.attempts[0].provider_attempt_id = "different-provider-payment";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).toContain("intent_attempt_payment_ref");
  });

  it("uses a comparable mismatch as primary provider-event evidence ahead of an unavailable event", () => {
    const rows = fixture();
    rows.events.unshift({ ...rows.events[0], id: "event-unavailable", amount_cents: null, currency: null });
    rows.events[1].amount_cents = 9_999;

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.providerEvent).toMatchObject({ id: "event-one_time", state: "mismatch", amountCents: 9_999 });
    expect(evidence.mismatchCodes).toContain("provider_event_amount");
  });

  it("uses comparable matched provider money ahead of an unavailable duplicate event", () => {
    const rows = fixture();
    rows.events.unshift({ ...rows.events[0], id: "event-unavailable", amount_cents: null, currency: null });

    const snapshot = summarizeOrderMoneyReconciliation(rows, NOW);

    expect(snapshot.providerEventMoneyUnavailableCount).toBe(0);
    expect(snapshot.evidence[0].providerEvent).toMatchObject({
      id: "event-one_time",
      state: "matched",
      amountCents: 10_000,
      currency: "PLN",
    });
  });

  it("reports a settlement linked to a different payment provider", () => {
    const rows = fixture();
    rows.settlements[0].provider_kind = "stripe";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.providerSettlement.state).toBe("mismatch");
    expect(evidence.mismatchCodes).toContain("provider_settlement_provider");
  });

  it("fails closed on missing payment ledgers and non-canonical invoice positions", () => {
    const rows = fixture("renewal");
    rows.intents = [];
    rows.attempts = [];
    rows.events = [];
    rows.invoices[0].lines_snapshot = [{ quantity: 1, totalGrossMinor: 10_000, totalNetMinor: 9_259, vatRate: "8" }];

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).toEqual(expect.arrayContaining([
      "charge_intent_count",
      "invoice_positions_invalid",
    ]));
  });

  it("waits for the established accounting SLA before reporting a missing local invoice", () => {
    const recent = fixture();
    recent.invoices = [];
    recent.orders[0].updated_at = "2026-07-13T11:30:00.000Z";
    recent.intents[0].updated_at = "2026-07-13T11:30:00.000Z";
    recent.events[0].created_at = "2026-07-13T11:30:00.000Z";
    const stale = fixture("initial");
    stale.invoices = [];
    stale.orders[0].updated_at = "2026-07-13T10:59:59.000Z";
    stale.intents[0].updated_at = "2026-07-13T10:59:59.000Z";
    stale.events[0].created_at = "2026-07-13T10:59:59.000Z";

    expect(summarizeOrderMoneyReconciliation(recent, NOW).evidence[0].mismatchCodes)
      .not.toContain("base_invoice_count");
    expect(summarizeOrderMoneyReconciliation(stale, NOW).evidence[0].mismatchCodes)
      .toContain("base_invoice_count");
  });

  it("does not reset the paid invoice SLA when the intent is updated after trusted payment success", () => {
    const rows = fixture();
    rows.invoices = [];
    rows.events[0].created_at = "2026-07-13T10:00:00.000Z";
    rows.attempts[0].updated_at = "2026-07-13T10:00:00.000Z";
    rows.intents[0].updated_at = "2026-07-13T11:59:00.000Z";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.invoiceExpectation).toMatchObject({
      issueTrigger: "paid",
      state: "required",
      anchorAt: "2026-07-13T10:00:00.000Z",
    });
    expect(evidence.mismatchCodes).toContain("base_invoice_count");
  });

  it("anchors handoff-triggered invoice expectation to the actual fulfillment handoff", () => {
    const beforeHandoff = fixture();
    beforeHandoff.invoices = [];
    beforeHandoff.fulfillment = [{
      id: "fulfillment-packed",
      order_id: beforeHandoff.orders[0].id,
      status: "packed",
      handed_over_at: null,
    }];
    const duringGrace = fixture("initial");
    duringGrace.invoices = [];
    duringGrace.fulfillment = [{
      id: "fulfillment-recent",
      order_id: duringGrace.orders[0].id,
      status: "in_transit",
      handed_over_at: "2026-07-13T11:30:00.000Z",
    }];
    const overdue = fixture("renewal");
    overdue.invoices = [];
    overdue.fulfillment = [{
      id: "fulfillment-overdue",
      order_id: overdue.orders[0].id,
      status: "exception",
      handed_over_at: "2026-07-13T10:59:59.000Z",
    }];

    const evidence = [beforeHandoff, duringGrace, overdue].map((rows) =>
      summarizeOrderMoneyReconciliation(rows, NOW, { issueTrigger: "handoff" }).evidence[0]);

    expect(evidence[0]).toMatchObject({
      mismatchCodes: expect.not.arrayContaining(["base_invoice_count"]),
      invoiceExpectation: { issueTrigger: "handoff", state: "not_due", anchorAt: null },
    });
    expect(evidence[1]).toMatchObject({
      mismatchCodes: expect.not.arrayContaining(["base_invoice_count"]),
      invoiceExpectation: { issueTrigger: "handoff", state: "grace_period" },
    });
    expect(evidence[2]).toMatchObject({
      mismatchCodes: ["base_invoice_count"],
      invoiceExpectation: { issueTrigger: "handoff", state: "required" },
      disposition: "accounting_missing_invoice_owner",
    });
  });

  it("uses #1757 document history to compare the current replacement without counting corrections twice", () => {
    const rows = fixture();
    const root = rows.invoices[0];
    root.status = "corrected";
    root.metadata = {
      correctionProviderInvoiceId: "provider-correction-1",
      correctionProviderInvoiceNumber: "K1/2026",
    };
    rows.invoices.push({
      ...root,
      id: "invoice-replacement",
      invoice_ref: "OPENLUP-one_time:reissue-1",
      status: "issued",
      correction_of_invoice_id: root.id,
      provider_invoice_id: "provider-replacement-1",
      metadata: {},
      created_at: "2026-07-13T11:10:00.000Z",
      updated_at: "2026-07-13T11:10:00.000Z",
    });

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).toEqual([]);
    expect(evidence.invoice?.id).toBe("invoice-replacement");
    expect(evidence.relatedIds.baseInvoiceIds).toEqual([root.id]);
    expect(evidence.invoiceLineageIds).toMatchObject({
      rootInvoiceIds: [root.id],
      invoiceIds: [root.id, "invoice-replacement"],
      currentInvoiceId: "invoice-replacement",
    });
    expect(evidence.invoiceLineageIds.documentKeys).toEqual(expect.arrayContaining([
      `invoice:${root.id}`,
      `correction:${root.id}`,
      "invoice:invoice-replacement",
    ]));
  });

  it("validates the newest local issue-request snapshot before a provider document exists", () => {
    const rows = fixture();
    rows.invoices[0].status = "issue_requested";
    rows.invoices[0].provider_invoice_id = null;
    rows.invoices[0].total_gross_cents = 9_999;
    rows.invoices[0].lines_snapshot = [{ quantity: 1, totalGrossMinor: 9_999 }];

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.invoice?.id).toBe(rows.invoices[0].id);
    expect(evidence.invoiceLineageIds.currentInvoiceId).toBe(rows.invoices[0].id);
    expect(evidence.mismatchCodes).toEqual(expect.arrayContaining([
      "invoice_amount",
      "invoice_positions_invalid",
    ]));
    expect(evidence.mismatchCodes).not.toContain("base_invoice_count");
  });

  it.each(["draft", "rejected"])("does not present a %s invoice as the current fiscal document", (status) => {
    const rows = fixture();
    rows.invoices[0].status = status;
    rows.invoices[0].total_gross_cents = 9_999;

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.invoice).toBeNull();
    expect(evidence.invoiceLineageIds.currentInvoiceId).toBeNull();
    expect(evidence.mismatchCodes).not.toContain("invoice_amount");
  });

  it("accepts a provider-readback reconciliation that corrected payment without an inbound webhook event", () => {
    const rows = fixture();
    rows.events = [];
    rows.reconciliations = [{
      id: "reconciliation-1",
      payment_intent_id: rows.intents[0].id,
      payment_attempt_id: rows.attempts[0].id,
      correction_status: "corrected",
      provider_status: "succeeded",
      checked_at: "2026-07-13T11:30:00.000Z",
      payload: {
        source: "payment-provider-reconciliation.v0",
        normalizedStatus: "succeeded",
        resultStatus: "succeeded",
        applied: true,
        amountMinorPresent: true,
        currency: "PLN",
        providerPayload: { secret: "must-not-leak" },
      },
    }];

    const snapshot = summarizeOrderMoneyReconciliation(rows, NOW);
    const evidence = snapshot.evidence[0];

    expect(evidence.mismatchCodes).not.toContain("trusted_provider_event_missing");
    expect(evidence.providerEvent).toMatchObject({ id: "reconciliation-1", state: "unavailable", amountCents: null, currency: "PLN" });
    expect(snapshot.providerEventMoneyUnavailableCount).toBe(1);
    expect(evidence.relatedIds.trustedProviderReconciliationIds).toEqual(["reconciliation-1"]);
    expect(JSON.stringify(evidence)).not.toContain("must-not-leak");
  });

  it("keeps a local settlement mismatch mandatory when provider provenance is unavailable", () => {
    const rows = fixture();
    rows.settlements[0].gross_cents = 9_999;
    rows.settlements[0].evidence = { source: "manual_entry" };

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.localSettlement).toMatchObject({ state: "mismatch", amountCents: 9_999 });
    expect(evidence.providerSettlement).toEqual({
      state: "unsupported",
      reason: "provider_settlement_import_unsupported:tpay",
    });
    expect(evidence.mismatchCodes).toContain("provider_settlement_amount");
  });

  it("keeps an untrusted reconciliation from masking a missing provider success event", () => {
    const rows = fixture();
    rows.events = [];
    rows.reconciliations = [{
      id: "manual-reconciliation",
      payment_intent_id: rows.intents[0].id,
      payment_attempt_id: rows.attempts[0].id,
      correction_status: "corrected",
      provider_status: "succeeded",
      checked_at: "2026-07-13T11:30:00.000Z",
      payload: { source: "manual_entry", normalizedStatus: "succeeded", resultStatus: "succeeded", applied: true },
    }];

    expect(summarizeOrderMoneyReconciliation(rows, NOW).evidence[0].mismatchCodes)
      .toContain("trusted_provider_event_missing");
  });

  it("reconciles the original charge for a refunded order and refunded payment intent", () => {
    const rows = fixture();
    rows.orders[0].status = "refunded";
    rows.intents[0].status = "refunded";

    const evidence = summarizeOrderMoneyReconciliation(rows, NOW).evidence[0];

    expect(evidence.mismatchCodes).not.toContain("charge_intent_count");
    expect(evidence.intent?.id).toBe(rows.intents[0].id);
  });
});

function fixture(kind: "one_time" | "initial" | "renewal" = "one_time"): OrderMoneyReconciliationRows {
  const suffix = kind;
  const orderId = `order-${suffix}`;
  const intentId = `intent-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const cycleId = kind === "one_time" ? null : `cycle-${suffix}`;
  return {
    orders: [{ id: orderId, order_number: `OPENLUP-${suffix}`, mode: kind === "one_time" ? "one_time" : "subscription_cycle", status: "paid", subtotal_cents: 10_000, discount_cents: 1_000, shipping_cents: 1_500, shipping_discount_cents: 500, tax_cents: 741, total_cents: 10_000, currency: "pln", subscription_cycle_id: cycleId, updated_at: "2026-07-13T11:00:00.000Z" }],
    items: [{ id: `item-${suffix}`, order_id: orderId, allocation_ordinal: 1, quantity: 2, total_cents: 10_000, discount_allocated_cents: 1_000, effective_total_cents: 9_000, effective_net_cents: 8_333, vat_rate_bps: 800 }],
    cycles: cycleId ? [{ id: cycleId, cycle_number: kind === "initial" ? 1 : 2 }] : [],
    intents: [{ id: intentId, order_id: orderId, payment_id: `payment-${suffix}`, status: "succeeded", amount_cents: 10_000, currency: "PLN", active_attempt_id: attemptId, provider_payment_id: `provider-payment-${suffix}`, updated_at: "2026-07-13T11:00:00.000Z" }],
    attempts: [{ id: attemptId, created_at: "2026-07-13T10:55:00.000Z", updated_at: "2026-07-13T11:00:00.000Z", payment_intent_id: intentId, provider: "tpay", status: "succeeded", amount_cents: 10_000, currency: "PLN", provider_attempt_id: `provider-payment-${suffix}` }],
    events: [{ id: `event-${suffix}`, created_at: "2026-07-13T11:00:00.000Z", provider: "tpay", provider_event_id: `provider-event-${suffix}`, provider_payment_id: `provider-payment-${suffix}`, payment_intent_id: intentId, payment_attempt_id: attemptId, event_type: "payment.succeeded", amount_cents: 10_000, currency: "PLN", signature_verified: true }],
    reconciliations: [],
    settlements: [{ id: `settlement-${suffix}`, created_at: "2026-07-13T11:00:00.000Z", batch_id: `batch-${suffix}`, provider_kind: "tpay", provider_payment_id: `provider-payment-${suffix}`, payment_intent_id: intentId, payment_id: `payment-${suffix}`, invoice_id: `invoice-${suffix}`, status: "matched", gross_cents: 10_000, currency: "PLN", evidence: { providerReadbackSource: "provider_api", rawToken: "must-not-leak" } }],
    invoices: [{
      id: `invoice-${suffix}`,
      order_id: orderId,
      invoice_ref: `OPENLUP-${suffix}`,
      status: "issued",
      correction_of_invoice_id: null,
      provider_kind: "fakturownia",
      provider_invoice_id: `provider-invoice-${suffix}`,
      blocked_reason: null,
      total_gross_cents: 10_000,
      total_net_cents: 9_259,
      currency: "PLN",
      lines_snapshot: canonicalPositions(10_000, 9_259, `item-${suffix}`),
      metadata: {},
      created_at: "2026-07-13T11:05:00.000Z",
      updated_at: "2026-07-13T11:05:00.000Z",
      ksef_status: "not_required",
    }],
    fulfillment: [],
  };
}

function canonicalPositions(gross: number, net: number, orderItemId: string) {
  const itemGross = gross - 1_000;
  const itemNet = net - 926;
  return [
    { positionKind: "item", orderItemId, allocationOrdinal: 1, name: "Karma", quantity: 2, unitGrossMinor: Math.round(itemGross / 2), totalGrossMinor: itemGross, unitNetMinor: Math.round(itemNet / 2), totalNetMinor: itemNet, vatRate: "8", vatRateBps: 800, discountAllocatedMinor: 1_000, catalogTotalGrossMinor: itemGross + 1_000 },
    { positionKind: "delivery", orderItemId: null, name: "Dostawa", quantity: 1, unitGrossMinor: 1_000, totalGrossMinor: 1_000, unitNetMinor: 926, totalNetMinor: 926, vatRate: "8", vatRateBps: 800, shippingGrossMinor: 1_500, shippingDiscountMinor: 500 },
  ];
}

function merge(...fixtures: OrderMoneyReconciliationRows[]): OrderMoneyReconciliationRows {
  return {
    orders: fixtures.flatMap((row) => row.orders),
    items: fixtures.flatMap((row) => row.items),
    cycles: fixtures.flatMap((row) => row.cycles),
    intents: fixtures.flatMap((row) => row.intents),
    attempts: fixtures.flatMap((row) => row.attempts),
    events: fixtures.flatMap((row) => row.events),
    reconciliations: fixtures.flatMap((row) => row.reconciliations),
    settlements: fixtures.flatMap((row) => row.settlements),
    invoices: fixtures.flatMap((row) => row.invoices),
    fulfillment: fixtures.flatMap((row) => row.fulfillment),
  };
}

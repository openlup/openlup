import { describe, expect, it } from "vitest";
import { readOrderMoneyReconciliationRows } from "./orderMoneyReconciliationRows.js";

describe("canonical order money reconciliation reads", () => {
  it("pages through every paid order instead of accepting a default row cap", async () => {
    const ranges: Array<[number, number]> = [];
    const orders = Array.from({ length: 501 }, (_, index) => ({
      id: `order-${String(index).padStart(4, "0")}`,
      order_number: `OPENLUP-${index}`,
      mode: "one_time",
      status: "paid",
      total_cents: 1000,
      currency: "PLN",
      subscription_cycle_id: null,
      updated_at: "2026-07-13T10:00:00.000Z",
    }));

    const rows = await readOrderMoneyReconciliationRows(fakeClient({ commerce_orders: orders }, ranges) as never);

    expect(rows.orders).toHaveLength(501);
    expect(ranges.slice(0, 2)).toEqual([[0, 499], [500, 999]]);
  });

  it("includes refunded orders and cancelled orders that already have a provider invoice", async () => {
    const orders = [
      order("refunded", "refunded"),
      order("cancelled-invoiced", "cancelled"),
      order("cancelled-uninvoiced", "cancelled"),
    ];
    const invoices = [{
      id: "invoice-1",
      order_id: "cancelled-invoiced",
      status: "corrected",
      correction_of_invoice_id: null,
      provider_invoice_id: "provider-invoice-1",
      total_gross_cents: 1000,
      total_net_cents: 926,
      currency: "PLN",
      lines_snapshot: [],
    }];

    const rows = await readOrderMoneyReconciliationRows(fakeClient({
      commerce_orders: orders,
      accounting_invoices: invoices,
    }, []) as never);

    expect(rows.orders.map((row) => row.id).sort()).toEqual(["cancelled-invoiced", "refunded"]);
    expect(rows.invoices.map((row) => row.id)).toEqual(["invoice-1"]);
  });

  it("uses provider document identity across issued and KSeF lifecycle statuses", async () => {
    const base = {
      correction_of_invoice_id: null,
      total_gross_cents: 1000,
      total_net_cents: 926,
      currency: "PLN",
      lines_snapshot: [],
    };
    const rows = await readOrderMoneyReconciliationRows(fakeClient({
      commerce_orders: [
        order("requested", "paid"),
        order("voided", "paid"),
        order("issued", "paid"),
        order("ksef-pending", "paid"),
        order("ksef-rejected", "paid"),
      ],
      accounting_invoices: [
        { ...base, id: "invoice-requested", order_id: "requested", status: "issue_requested", provider_invoice_id: null },
        { ...base, id: "invoice-voided", order_id: "voided", status: "voided", provider_invoice_id: null },
        { ...base, id: "invoice-issued", order_id: "issued", status: "issued", provider_invoice_id: "fv-issued" },
        { ...base, id: "invoice-ksef-pending", order_id: "ksef-pending", status: "ksef_pending", provider_invoice_id: "fv-pending" },
        { ...base, id: "invoice-ksef-rejected", order_id: "ksef-rejected", status: "rejected", provider_invoice_id: "fv-rejected" },
      ],
    }, []) as never);

    expect(rows.invoices.map((row) => row.id).sort()).toEqual([
      "invoice-issued",
      "invoice-ksef-pending",
      "invoice-ksef-rejected",
      "invoice-requested",
    ]);
  });

  it("retains replacement lineage and fulfillment handoff evidence for the summarizer", async () => {
    const root = {
      id: "invoice-root",
      order_id: "paid-order",
      status: "corrected",
      correction_of_invoice_id: null,
      provider_invoice_id: "fv-root",
      total_gross_cents: 1000,
      total_net_cents: 926,
      currency: "PLN",
      lines_snapshot: [],
    };
    const rows = await readOrderMoneyReconciliationRows(fakeClient({
      commerce_orders: [order("paid-order", "paid")],
      accounting_invoices: [
        root,
        { ...root, id: "invoice-replacement", status: "issued", correction_of_invoice_id: root.id, provider_invoice_id: "fv-replacement" },
      ],
      commerce_fulfillment_orders: [{
        id: "fulfillment-1",
        order_id: "paid-order",
        status: "in_transit",
        handed_over_at: "2026-07-13T10:30:00.000Z",
      }],
    }, []) as never);

    expect(rows.invoices.map((row) => row.id).sort()).toEqual(["invoice-replacement", "invoice-root"]);
    expect(rows.fulfillment).toEqual([expect.objectContaining({ id: "fulfillment-1", status: "in_transit" })]);
  });

  it("unions trusted settlement links and only resolves consistent intent ownership", async () => {
    const paymentIntent = {
      id: "intent-1",
      order_id: "paid-order",
      payment_id: "payment-1",
      status: "succeeded",
      amount_cents: 1000,
      currency: "PLN",
      active_attempt_id: "attempt-1",
      provider_payment_id: "provider-payment-1",
      updated_at: "2026-07-13T10:00:00.000Z",
    };
    const invoice = {
      id: "invoice-1",
      order_id: "paid-order",
      status: "ksef_pending",
      correction_of_invoice_id: null,
      provider_invoice_id: "fv-1",
      total_gross_cents: 1000,
      total_net_cents: 926,
      currency: "PLN",
      lines_snapshot: [],
    };
    const settlementBase = {
      created_at: "2026-07-13T10:00:00.000Z",
      batch_id: "batch-1",
      provider_kind: "tpay",
      provider_payment_id: "provider-payment-1",
      status: "matched",
      gross_cents: 1000,
      currency: "PLN",
      evidence: { providerReadbackSource: "provider_api" },
    };
    const rows = await readOrderMoneyReconciliationRows(fakeClient({
      commerce_orders: [order("paid-order", "paid")],
      commerce_payment_intents: [paymentIntent],
      accounting_invoices: [invoice],
      payment_provider_settlement_items: [
        { ...settlementBase, id: "settlement-intent", payment_intent_id: "intent-1", payment_id: null, invoice_id: null },
        { ...settlementBase, id: "settlement-payment", payment_intent_id: null, payment_id: "payment-1", invoice_id: null },
        { ...settlementBase, id: "settlement-invoice", payment_intent_id: null, payment_id: null, invoice_id: "invoice-1" },
        { ...settlementBase, id: "settlement-all-links", payment_intent_id: "intent-1", payment_id: "payment-1", invoice_id: "invoice-1" },
        { ...settlementBase, id: "settlement-conflict", payment_intent_id: "intent-other", payment_id: "payment-1", invoice_id: null },
      ],
    }, []) as never);

    expect(rows.settlements).toHaveLength(5);
    expect(rows.settlements.filter((row) => row.payment_intent_id === "intent-1").map((row) => row.id).sort()).toEqual([
      "settlement-all-links",
      "settlement-conflict",
      "settlement-intent",
      "settlement-invoice",
      "settlement-payment",
    ]);
    expect(rows.settlements.find((row) => row.id === "settlement-conflict")).toMatchObject({
      payment_intent_id: "intent-1",
      correlation_issue: "conflicting_links",
    });
  });

  it("does not guess an intent from an invoice when an order has multiple payment intents", async () => {
    const intents = [
      paymentIntent("intent-first", "payment-first"),
      paymentIntent("intent-retry", "payment-retry"),
    ];
    const rows = await readOrderMoneyReconciliationRows(fakeClient({
      commerce_orders: [order("paid-order", "paid")],
      commerce_payment_intents: intents,
      accounting_invoices: [{
        id: "invoice-ambiguous",
        order_id: "paid-order",
        status: "issued",
        correction_of_invoice_id: null,
        provider_invoice_id: "fv-ambiguous",
        total_gross_cents: 1000,
        total_net_cents: 926,
        currency: "PLN",
        lines_snapshot: [],
      }],
      payment_provider_settlement_items: [{
        id: "settlement-invoice-only",
        created_at: "2026-07-13T10:00:00.000Z",
        batch_id: "batch-1",
        provider_kind: "tpay",
        provider_payment_id: "unmatched-provider-payment",
        payment_intent_id: null,
        payment_id: null,
        invoice_id: "invoice-ambiguous",
        status: "matched",
        gross_cents: 1000,
        currency: "PLN",
        evidence: { providerReadbackSource: "provider_api" },
      }, {
        id: "settlement-direct-and-invoice",
        created_at: "2026-07-13T10:00:00.000Z",
        batch_id: "batch-2",
        provider_kind: "tpay",
        provider_payment_id: "provider-payment-first",
        payment_intent_id: "intent-first",
        payment_id: null,
        invoice_id: "invoice-ambiguous",
        status: "matched",
        gross_cents: 1000,
        currency: "PLN",
        evidence: { providerReadbackSource: "provider_api" },
      }, {
        id: "settlement-provider-ref-only",
        created_at: "2026-07-13T10:00:00.000Z",
        batch_id: "batch-3",
        provider_kind: "tpay",
        provider_payment_id: "provider-payment-retry",
        payment_intent_id: null,
        payment_id: null,
        invoice_id: null,
        status: "unmatched",
        gross_cents: 1000,
        currency: "PLN",
        evidence: { providerReadbackSource: "provider_api" },
      }],
    }, []) as never);

    expect(rows.settlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "settlement-invoice-only", payment_intent_id: "intent-first", correlation_issue: "conflicting_links" }),
      expect.objectContaining({ id: "settlement-invoice-only", payment_intent_id: "intent-retry", correlation_issue: "conflicting_links" }),
      expect.objectContaining({ id: "settlement-direct-and-invoice", payment_intent_id: "intent-first", correlation_issue: undefined }),
      expect.objectContaining({ id: "settlement-provider-ref-only", payment_intent_id: "intent-retry", correlation_issue: undefined }),
    ]));
  });

  it("fails the mandatory local settlement read when its table query fails", async () => {
    await expect(readOrderMoneyReconciliationRows(fakeClient({
      commerce_orders: [order("paid-order", "paid")],
      commerce_payment_intents: [paymentIntent("intent-1", "payment-1")],
    }, [], new Set(["payment_provider_settlement_items"])) as never))
      .rejects.toThrow(/payment_provider_settlement_items/);
  });
});

function paymentIntent(id: string, paymentId: string) {
  return {
    id,
    order_id: "paid-order",
    payment_id: paymentId,
    status: "succeeded",
    amount_cents: 1000,
    currency: "PLN",
    active_attempt_id: null,
    provider_payment_id: `provider-${paymentId}`,
    updated_at: "2026-07-13T10:00:00.000Z",
  };
}

function order(id: string, status: string) {
  return {
    id,
    order_number: `OPENLUP-${id}`,
    mode: "one_time",
    status,
    subtotal_cents: 1000,
    discount_cents: 0,
    shipping_cents: 0,
    shipping_discount_cents: 0,
    tax_cents: 74,
    total_cents: 1000,
    currency: "PLN",
    subscription_cycle_id: null,
    updated_at: "2026-07-13T10:00:00.000Z",
  };
}

function fakeClient(
  tables: Record<string, Array<Record<string, unknown>>>,
  orderRanges: Array<[number, number]>,
  errorTables = new Set<string>(),
) {
  return {
    from(table: string) {
      return query(tables[table] ?? [], table === "commerce_orders" ? orderRanges : [], errorTables.has(table));
    },
  };
}

function query(source: Array<Record<string, unknown>>, rangeLog: Array<[number, number]>, fails = false) {
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
      rangeLog.push([from, to]);
      return builder;
    },
    then(resolve: (value: { data: typeof rows | null; error: null | { message: string } }) => void) {
      const selected = range ? rows.slice(range[0], range[1] + 1) : rows;
      resolve(fails
        ? { data: null, error: { message: "forced settlement table failure" } }
        : { data: selected, error: null });
    },
  };
  return builder;
}

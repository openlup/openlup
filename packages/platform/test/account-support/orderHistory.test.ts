import { expect, it, vi } from "vitest";
import { readCustomerOrderDetail, readCustomerOrderSummaries, lineListTotalMinor, mapCustomerOrderLines, customerOrderMoney, toOrderMoneyHeader, toOrderMoneyItem } from "../../src/account-support/index.js";
import type { CustomerOrderHistoryReadStore, CustomerOrderHistoryProjectionPort } from "../../src/account-support/index.js";

const projection: CustomerOrderHistoryProjectionPort = {
  automaticHoldSource: "host.hold",
  automaticReleaseSource: "host.release",
  orderReference: id => `REF-${id}`,
  fulfillmentEvidence: () => ({
    trackingNumber: null,
    trackingNumbers: [],
    trackingReferences: [],
    trackingUrl: null,
    carrierKind: null,
    service: null,
    trackingTimeline: []
  }),
  presentation: { display: () => ({ title: "Captured item", variantName: "Captured variant", displayLabel: "Agreed label" }) }
};

function store(): CustomerOrderHistoryReadStore {
  return {
    readCustomerOrders: vi.fn(async () => []),
    readCustomerOrder: vi.fn(async () => null),
    readOrderLines: vi.fn(async () => []),
    readPaymentStatuses: vi.fn(async () => new Map()),
    readFulfillments: vi.fn(async () => []),
    readTracking: vi.fn(async () => new Map()),
    readFulfillmentOperations: vi.fn(async () => new Map()),
    readStatusEvidence: vi.fn(async () => new Map()),
    readReleasedProviderExceptionHolds: vi.fn(async () => new Map()),
    readReleasedProviderExceptionEvidence: vi.fn(async () => new Map()),
    readActiveHoldOrderIds: vi.fn(async () => new Set()),
    readInvoiceSummaries: vi.fn(async () => new Map())
  };
}

it(
  "uses stored denomination and effective shipping discount with captured line display",
  async () => {
    const input = store();
    input.readCustomerOrder = vi.fn(async () => ({
      id: "o",
      status: "paid",
      currency: "EUR",
      subtotal_cents: 200,
      discount_cents: 20,
      shipping_cents: 50,
      shipping_discount_cents: 50,
      tax_cents: 0,
      total_cents: 180
    }));
    input.readOrderLines = vi.fn(async () => [{
      id: "l",
      quantity: 2,
      unit_price_cents: 100,
      total_cents: 200,
      discount_allocated_cents: 20,
      effective_total_cents: 180,
      effective_net_cents: 180,
      vat_rate_bps: 0,
      product_snapshot: { quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: 240 }] } }
    }]);
    const result = await readCustomerOrderDetail(input, "owner", "o", projection);
    expect(result?.order.total).toEqual({ amountMinor: 180, currency: "EUR" });
    expect(result?.order.shipping.amountMinor).toBe(0);
    expect(result?.order.lines[0]).toMatchObject({
      title: "Captured item",
      total: { amountMinor: 200, currency: "EUR" },
      discount: { amountMinor: 40, currency: "EUR" }
    });
    expect(result?.order.orderNumber).toBe("REF-o");
  }
);
it(
  "refuses a missing/foreign owned detail before every companion and passes the terminal-only history filter",
  async () => {
    const input = store();
    expect(await readCustomerOrderDetail(input, "other", "foreign", projection)).toBeNull();
    expect(input.readOrderLines).not.toHaveBeenCalled();
    expect(input.readPaymentStatuses).not.toHaveBeenCalled();
    expect(input.readInvoiceSummaries).not.toHaveBeenCalled();

  }
);

it("passes the terminal-only history filter", async () => {
  const input = store();
    expect(await readCustomerOrderSummaries(input, "owner", 17, projection)).toEqual({ contractVersion: "customer.orders.v2", orders: [] });
    expect(input.readCustomerOrders).toHaveBeenCalledExactlyOnceWith("owner", ["cancelled", "expired"], 17);
});
// Fresh neutral companions, characterized from the donor's parcel, recovery and hold composition.
it.each([
  { reader: "summary", status: "paid", active: false, step: "delivered" },
  { reader: "detail", status: "paid", active: false, step: "delivered" },
  { reader: "summary", status: "paid", active: true, step: "exception" },
  { reader: "detail", status: "paid", active: true, step: "exception" },
  { reader: "summary", status: "cancelled", active: false, step: "cancelled" },
  { reader: "detail", status: "cancelled", active: false, step: "cancelled" },
  { reader: "summary", status: "cancelled", active: true, step: "exception" },
  { reader: "detail", status: "cancelled", active: true, step: "exception" }
])("selects replacement tracking and forwards recovery: $reader / $status / hold=$active", async ({ reader, status, active, step }) => {
  const input = store();
  const row = {
    id: "o", status, currency: "EUR", subtotal_cents: 100, discount_cents: 0,
    shipping_cents: 0, tax_cents: 0, total_cents: 100
  };
  input.readCustomerOrders = vi.fn(async () => [row]);
  input.readCustomerOrder = vi.fn(async () => row);
  input.readPaymentStatuses = vi.fn(async () => new Map([["o", "paid"]]));
  input.readFulfillments = vi.fn(async () => [
    { id: "P0", order_id: "o", sequence_no: 0, status: "exception" },
    { id: "P1", order_id: "o", sequence_no: 1, status: "delivered" }
  ]);
  const original = { fulfillment_order_id: "P0", tracking_number: "TRACK-ORIGINAL" };
  const replacement = { fulfillment_order_id: "P1", tracking_number: "TRACK-REPLACEMENT" };
  input.readTracking = vi.fn(async () => new Map([["o", [original, replacement]]]));
  const occurredAt = "2031-01-01T00:00:00Z", recoveredAt = "2031-01-02T00:00:00Z";
  const failed = {
    id: "failed-evidence", fulfillment_order_id: "P1", provider_status: "SUSPENDED", local_status: "exception", occurred_at: occurredAt
  };
  const recovered = {
    id: "delivered-evidence", fulfillment_order_id: "P1", provider_status: "DELIVERED", local_status: "delivered", occurred_at: recoveredAt
  };
  input.readStatusEvidence = vi.fn(async () => new Map([["o", [failed]]]));
  const holds = new Map([["o", [{
    status: "released", reason: "fulfillment_exception", createdBy: null, releasedBy: null,
    metadata: {
      source: "host.hold", autoReleased: true, autoReleaseSource: "host.release", autoReleaseProof: "delivered",
      autoReleaseEvidence: {
        fulfillmentOrderId: "P1", clearedStatusEvidenceId: "failed-evidence", statusEvidenceId: "delivered-evidence",
        clearedOccurredAt: occurredAt, occurredAt: recoveredAt, clearedProviderStatus: "SUSPENDED", localStatus: "delivered"
      }
    }
  }]]] );
  input.readReleasedProviderExceptionHolds = vi.fn(async () => holds);
  input.readReleasedProviderExceptionEvidence = vi.fn(async () => new Map([["o", [recovered]]]));
  const operations = [{ id: "op", operation_type: "parcel_delivered", occurred_at: recoveredAt }];
  input.readFulfillmentOperations = vi.fn(async () => new Map([["o", operations]]));
  input.readActiveHoldOrderIds = vi.fn(async () => new Set(active ? ["o"] : []));
  const interpret = vi.fn<CustomerOrderHistoryProjectionPort["fulfillmentEvidence"]>(({ trackingRefs }) => {
    const numbers = trackingRefs.map(ref => String(ref.tracking_number));
    return {
      trackingNumber: numbers[0] ?? null, trackingNumbers: numbers, trackingUrl: null, carrierKind: null, service: null,
      trackingReferences: numbers.map(trackingNumber => ({
        trackingNumber, providerKind: "host", trackingUrl: null, carrierKind: null, service: null, updatedAt: null
      })), trackingTimeline: []
    };
  });
  const selected = { ...projection, fulfillmentEvidence: interpret };
  const result = reader === "summary"
    ? (await readCustomerOrderSummaries(input, "owner", 17, selected)).orders[0]!
    : (await readCustomerOrderDetail(input, "owner", "o", selected))!.order;
  expect(result).toMatchObject({
    orderId: "o", paymentStatus: "paid", fulfillmentStatus: "delivered", customerFulfillmentStep: step,
    trackingNumber: "TRACK-REPLACEMENT", trackingNumbers: ["TRACK-REPLACEMENT"],
    trackingReferences: [{ trackingNumber: "TRACK-REPLACEMENT", providerKind: "host" }]
  });
  expect(JSON.stringify(result)).not.toContain("TRACK-ORIGINAL");
  if ("fulfillment" in result) expect(result.fulfillment).toMatchObject({
    fulfillmentOrderId: "P1", trackingNumber: "TRACK-REPLACEMENT", trackingNumbers: ["TRACK-REPLACEMENT"]
  });
  expect(input.readFulfillments).toHaveBeenCalledExactlyOnceWith("owner", ["o"]);
  expect(input.readReleasedProviderExceptionEvidence).toHaveBeenCalledExactlyOnceWith(holds);
  expect(interpret).toHaveBeenCalledTimes(2);
  for (const [received] of interpret.mock.calls) expect(received).toEqual({
    trackingRefs: [replacement], statusEvidenceRows: [failed, recovered], operationRows: operations,
    recovery: { clearedExceptionEvidenceIds: new Set(["failed-evidence"]), recoveryEvidenceIds: new Set(["delivered-evidence"]) }
  });
});

it.each([
  { name: "root invoice request", metadata: { invoiceBuyerSnapshot: { taxId: "synthetic" } }, history: undefined, expected: "preparing" },
  { name: "nested invoice request", metadata: { runtimeFinalize: { invoiceBuyerSnapshot: { taxId: "synthetic" } } }, history: undefined, expected: "preparing" },
  { name: "selected empty history", metadata: null, history: { invoice: null, invoiceDocuments: [] }, expected: "preparing" },
  { name: "downloadable history", metadata: null, history: { invoice: { downloadAvailable: true }, invoiceDocuments: [] }, expected: "available" },
  { name: "absent companions", metadata: [], history: undefined, expected: "not_requested" }
])("sweeps order invoice request: $name", async ({ metadata, history, expected }) => {
  const input = store();
  input.readCustomerOrder = vi.fn(async () => ({ id: "o", status: "paid", order_number: "CAPTURED", metadata,
    currency: "EUR", subtotal_cents: 0, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0 }));
  if (history) input.readInvoiceSummaries = async () => new Map([["o", history as Awaited<ReturnType<CustomerOrderHistoryReadStore["readInvoiceSummaries"]>> extends Map<string, infer T> ? T : never]]);
  const result = (await readCustomerOrderDetail(input, "owner", "o", projection))!.order;
  expect(result).toMatchObject({ orderNumber: "CAPTURED", invoiceRequestStatus: expected, invoiceDocuments: [],
    invoice: history?.invoice ?? null, paymentStatus: null, fulfillmentStatus: null, fulfillment: null,
    subscriptionId: null, createdAt: "", updatedAt: "" });
});
it.each(["parcel fields", "tracking fallbacks", "timeline fallback", "absent fallbacks"])("sweeps fulfillment fields: %s", async mode => {
  const input = store();
  input.readCustomerOrder = async () => ({ id: "o", status: "paid", currency: "EUR", subtotal_cents: 0, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0 });
  input.readFulfillments = async () => [{ id: "P", order_id: "o", status: "shipped",
    ...(mode === "parcel fields" ? { provider_kind: "parcel-provider", updated_at: "parcel-time" } : {}) }, { id: "orphan" }];
  input.readFulfillmentOperations = async () => new Map((mode === "absent fallbacks" || mode === "timeline fallback") ? [] : [["o", [{ operation_type: "operation", occurred_at: "operation-time" }]]]);
  const evidence = { id: "existing", local_status: "shipped" };
  input.readStatusEvidence = async () => new Map([["o", [evidence]]]);
  input.readReleasedProviderExceptionEvidence = async () => new Map([["o", [evidence, { id: "new", local_status: "shipped" }]]]);
  const interpret = vi.fn<CustomerOrderHistoryProjectionPort["fulfillmentEvidence"]>(() => ({
    ...projection.fulfillmentEvidence({ trackingRefs: [], statusEvidenceRows: [], operationRows: [] }),
    trackingReferences: mode === "absent fallbacks" ? [] : [{ providerKind: "tracking-provider", trackingNumber: "T", trackingUrl: null,
      carrierKind: null, service: null, updatedAt: null }],
    trackingTimeline: mode === "absent fallbacks" ? [] : [{ eventType: "timeline", occurredAt: null, label: "Observed", source: "fulfillment" }]
  }));
  const result = (await readCustomerOrderDetail(input, "owner", "o", { ...projection, fulfillmentEvidence: interpret }))!.order;
  expect(result.fulfillment).toMatchObject({ fulfillmentOrderId: "P", status: "shipped",
    providerKind: mode === "parcel fields" ? "parcel-provider" : mode !== "absent fallbacks" ? "tracking-provider" : null,
    lastEventType: mode === "absent fallbacks" ? null : mode === "timeline fallback" ? "timeline" : "operation",
    updatedAt: mode === "parcel fields" ? "parcel-time" : mode === "tracking fallbacks" ? "operation-time" : null });
  expect(interpret.mock.calls.filter(([call]) => call.statusEvidenceRows.length).map(([call]) => call.statusEvidenceRows))
    .toEqual([[evidence, { id: "new", local_status: "shipped" }], [evidence, { id: "new", local_status: "shipped" }]]);
});

it.each([
  { name: "no pricing array", snapshot: {}, expected: null },
  { name: "no base components", snapshot: { quoteLine: { pricingComponents: [null, { componentType: "discount", amountMinor: 900 }] } }, expected: null },
  { name: "multiple base components", snapshot: { quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: 10 }, { componentType: "base_unit" }] } }, expected: 10 }
])("sweeps list pricing: $name", ({ snapshot, expected }) => expect(lineListTotalMinor(snapshot)).toBe(expected));
it.each([
  { name: "stored fallback", row: { id: "l", quantity: 2, unit_price_cents: 4, total_cents: 8 }, money: [], total: 8, unit: 4 },
  { name: "missing stored amount", row: { id: "l", quantity: 1 }, money: [], total: 0, unit: 0 },
  { name: "canonical precedence", row: { id: "l", quantity: 2, unit_price_cents: 900, total_cents: 1800 },
    money: [{ catalogTotal: 8, catalogUnit: 4 }], total: 8, unit: 4 }
])("sweeps line money: $name", ({ row, money, total, unit }) => {
  const result = mapCustomerOrderLines([row], money as Parameters<typeof mapCustomerOrderLines>[1], "EUR", projection.presentation);
  expect(result).toEqual([{ lineId: "l", skuId: null, title: "Captured item", variantName: "Captured variant", displayLabel: "Agreed label",
    quantity: row.quantity, unitPrice: { amountMinor: unit, currency: "EUR" }, total: { amountMinor: total, currency: "EUR" }, listTotal: null, discount: null }]);
});
it.each([8])("sweeps non-saving list price: %i", list => {
  const [result] = mapCustomerOrderLines([{ id: "l", quantity: 1, total_cents: 8,
    product_snapshot: { quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: list }] } } }], [], "EUR", projection.presentation);
  expect(result).toMatchObject({ listTotal: null, discount: null });
});
it.each([
  { name: "missing", value: undefined, expected: 0 },
  { name: "numeric string", value: "-12", expected: -12 }
])("sweeps stored money coercion: $name", ({ value, expected }) => expect(customerOrderMoney(value, "AAA")).toEqual({ amountMinor: expected, currency: "AAA" }));
it.each([false, true])("sweeps money row optionals: %s", present => {
  const row = present ? { id: "o", currency: "AAA", quantity: "2", unit_price_cents: "3", total_cents: "6",
    subtotal_cents: "6", discount_cents: "1", shipping_cents: "2", shipping_discount_cents: 1, tax_cents: "0",
    discount_allocated_cents: 1, effective_total_cents: 5, effective_net_cents: 4, vat_rate_bps: "100" } : {
    id: null, currency: null, quantity: 0, unit_price_cents: 0, total_cents: 0, subtotal_cents: 0, discount_cents: 0,
    shipping_cents: 0, tax_cents: 0, discount_allocated_cents: "1", effective_total_cents: "5", effective_net_cents: "4", vat_rate_bps: 0
  };
  expect(toOrderMoneyHeader(row)).toEqual({ id: present ? "o" : "", currency: present ? "AAA" : "", subtotal_cents: present ? 6 : 0,
    discount_cents: present ? 1 : 0, shipping_cents: present ? 2 : 0, shipping_discount_cents: present ? 1 : 0, tax_cents: 0, total_cents: present ? 6 : 0 });
  expect(toOrderMoneyItem(row)).toEqual({ id: present ? "o" : "", quantity: present ? 2 : 0, unit_price_cents: present ? 3 : 0,
    total_cents: present ? 6 : 0, discount_allocated_cents: present ? 1 : null, effective_total_cents: present ? 5 : null,
    effective_net_cents: present ? 4 : null, vat_rate_bps: present ? 100 : 0 });
});
it.each(["unattributed parcel"])("sweeps recovery attribution: %s", async () => {
  const input = store();
  input.readCustomerOrders = async () => [{ id: "", currency: "EUR", status: "paid", subtotal_cents: 0, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0 }];
  input.readFulfillments = async () => [{ id: "orphan" }];
  const interpret = vi.fn(projection.fulfillmentEvidence);
  await readCustomerOrderSummaries(input, "owner", 1, { ...projection, fulfillmentEvidence: interpret });
  expect(interpret.mock.calls.at(-1)?.[0].recovery).toBeUndefined();
});
it.each(["unattributed identity"])("sweeps missing parcel fields: %s", async () => {
  const input = store();
  input.readCustomerOrder = async () => ({ id: "o", status: "paid", currency: "EUR", subtotal_cents: 0, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0 });
  input.readFulfillments = async () => [{ order_id: "o" }];
  const result = (await readCustomerOrderDetail(input, "owner", "o", projection))!.order;
  expect(result.fulfillment).toEqual({ fulfillmentOrderId: null, status: null, providerKind: null, trackingNumber: null,
    trackingNumbers: [], trackingReferences: [], lastEventType: null, updatedAt: null, trackingTimeline: [] });
});
it.each(["released-only evidence"])("sweeps absent general evidence feed: %s", async () => {
  const input = store(), evidence = { id: "released", local_status: "delivered" };
  input.readCustomerOrders = async () => [{ id: "o", status: "paid", currency: "EUR", subtotal_cents: 0, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0 }];
  input.readReleasedProviderExceptionEvidence = async () => new Map([["o", [evidence]]]);
  const interpret = vi.fn(projection.fulfillmentEvidence);
  await readCustomerOrderSummaries(input, "owner", 1, { ...projection, fulfillmentEvidence: interpret });
  expect(interpret.mock.calls[0]?.[0]).toEqual({ trackingRefs: [], statusEvidenceRows: [evidence], operationRows: [], recovery: undefined });
});

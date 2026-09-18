import { describe, expect, it } from "vitest";
import { buildOmsOrderRowCore } from "./omsReadModelRowCore.js";
import { deriveOmsOrderMoney } from "./omsReadModelPricing.js";
import { mapCustomer } from "./omsReadModelHelpers.js";
import type {
  OmsAccountingInvoiceRow,
  OmsAccountingOutboxRow,
  OmsCustomerRow,
  OmsInventoryReservationRow,
  OmsOrderItemRow,
  OmsOrderRow,
  OmsPaymentAttemptRow,
  OmsPaymentIntentRow,
} from "./omsReadModelRows.js";

const orderId = "42222222-2222-4222-8222-2222222222a1";
const otherOrderId = "42222222-2222-4222-8222-2222222222a2";
const shipmentId = "d2222222-2222-4222-8222-2222222222a1";

const order: OmsOrderRow = {
  id: orderId,
  order_number: "V-2001",
  client_id: "41111111-1111-4111-8111-1111111111a1",
  status: "paid",
  mode: "subscription_cycle",
  currency: "XTS",
  subtotal_cents: 12900,
  discount_cents: 0,
  shipping_cents: 0,
  shipping_discount_cents: 0,
  tax_cents: 956,
  total_cents: 12900,
  metadata: null,
  created_at: "2026-06-05T10:00:00+00:00",
  updated_at: "2026-06-05T10:01:00+00:00",
  subscription_id: "43333333-3333-4333-8333-3333333333a1",
  subscription_cycle_id: "44444444-4444-4444-8444-4444444444a1",
  shipping_address_id: "45555555-5555-4555-8555-5555555555a1",
};

const customers: OmsCustomerRow[] = [
  { id: order.client_id!, email: "a@example.test", first_name: "A", last_name: "B", phone: null, lifecycle_stage: "active" },
];
// The identity is forwarded by the core untouched, so one value serves both
// arms; `mapPet` and `findPet` are proved by the helper suites, not here.
const identity = { customer: mapCustomer(customers[0]!), pet: null };
const paymentIntents: OmsPaymentIntentRow[] = [
  { id: "47777777-7777-4777-8777-7777777777a1", order_id: orderId, payment_id: "48888888-8888-4888-8888-8888888888a1", status: "succeeded", active_attempt_id: "49999999-9999-4999-8999-9999999999a1", provider_payment_id: "ext-1", updated_at: "2026-06-05T10:02:00+00:00" },
  { id: "47777777-7777-4777-8777-7777777777a2", order_id: otherOrderId, payment_id: "48888888-8888-4888-8888-8888888888a2", status: "requires_action", active_attempt_id: null, provider_payment_id: null, updated_at: "2026-06-05T10:02:00+00:00" },
];
const paymentAttempts: OmsPaymentAttemptRow[] = [
  { id: "49999999-9999-4999-8999-9999999999a1", payment_intent_id: paymentIntents[0]!.id, status: "succeeded", provider: "card-provider", provider_attempt_id: "att-1", next_action_kind: null, updated_at: "2026-06-05T10:02:00+00:00" },
];
const orderItems: OmsOrderItemRow[] = [
  { id: "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", order_id: orderId, sku_id: "sku-1", sku: "SKU-1", title: "Line", quantity: 2, unit_price_cents: 6450, total_cents: 12900 },
  { id: "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", order_id: otherOrderId, sku_id: "sku-2", sku: "SKU-2", title: "Decoy", quantity: 9, unit_price_cents: 100, total_cents: 900 },
];
const inventoryReservations: OmsInventoryReservationRow[] = [
  { id: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", order_id: orderId, order_item_id: orderItems[0]!.id, quantity: 2, status: "reserved", expires_at: null, location_id: "loc-1", inventory_locations: { code: "WH1" } },
  { id: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", order_id: otherOrderId, order_item_id: orderItems[1]!.id, quantity: 9, status: "released", expires_at: null, location_id: "loc-2" },
];
const fulfillmentOrders = [
  { id: shipmentId, order_id: orderId, status: "in_transit" as const, provider_kind: "dispatch-provider", delivered_at: null },
  { id: "d2222222-2222-4222-8222-2222222222a2", order_id: otherOrderId, status: "created" as const },
];
const fulfillmentOperations = [
  { fulfillment_order_id: shipmentId, operation_type: "handed_over", occurred_at: "2026-06-06T08:00:00+00:00" },
];
const shipmentExternalRefs = [
  { order_id: orderId, provider_tracking_id: "TRK-1", active: true, provider_kind: "carrier", tracking_url: "https://example.test/TRK-1", carrier_kind: "carrier", service: "standard", updated_at: "2026-06-06T08:05:00+00:00" },
  { order_id: otherOrderId, provider_tracking_id: "TRK-2", active: true },
];
const dispatchRefs = [
  { id: "dispatch-1", fulfillment_order_id: shipmentId, provider_order_id: "PO-1", dispatch_mode: "auto", status: "created", created_at: "2026-06-05T11:00:00+00:00", updated_at: "2026-06-05T11:00:00+00:00" },
];
const statusEvidence = [
  { id: "evidence-1", fulfillment_order_id: shipmentId, provider_status: "IN_TRANSIT", local_status: "in_transit", occurred_at: "2026-06-06T08:10:00+00:00", created_at: "2026-06-06T08:10:00+00:00" },
];
const releasedProviderExceptionHolds = [
  { order_id: orderId, status: "released", reason: "fulfillment_exception", created_by: null, released_by: null, metadata: {} },
  { order_id: otherOrderId, status: "released", reason: "fulfillment_exception", created_by: null, released_by: null, metadata: {} },
];
const accountingInvoices: OmsAccountingInvoiceRow[] = [
  { id: "4ccccccc-cccc-4ccc-8ccc-ccccccccccc1", order_id: orderId, invoice_ref: "INV-1", status: "issued", provider_kind: "invoicing", provider_invoice_number: "FV/1", ksef_status: null, total_gross_cents: 12900, currency: "XTS", updated_at: "2026-06-05T12:00:00+00:00" },
];
const accountingOutbox: OmsAccountingOutboxRow[] = [
  { invoice_id: accountingInvoices[0]!.id, status: "processed", attempt_count: 1, created_at: "2026-06-05T12:01:00+00:00" },
];

describe("OMS order row core", () => {
  // The one assumption the extraction stands on: the queue row and the detail row
  // are the SAME eleven-step build, and the only difference between the callers is
  // which rows arrive - the detail hands over singletons it already loaded, the list
  // narrows shared collections by order_id. Field-level parity checks elsewhere
  // cannot see a divergence in a field nobody asserts; whole-row equality can.
  it("builds an identical row from detail singletons and from list-narrowed collections", () => {
    const detail = buildOmsOrderRowCore({
      order,
      activeHoldCount: 0,
      paymentIntents: [paymentIntents[0]!],
      paymentAttempts,
      identity,
      orderItems: [orderItems[0]!],
      inventoryReservations: [inventoryReservations[0]!],
      fulfillmentOrders: [fulfillmentOrders[0]!],
      fulfillmentOperations,
      shipmentExternalRefs: [shipmentExternalRefs[0]!],
      providerAttempts: [],
      dispatchRefs,
      statusEvidence,
      releasedProviderExceptionHolds: [releasedProviderExceptionHolds[0]!],
      accountingInvoice: accountingInvoices[0]!,
      accountingOutbox,
      subscriptionCycleStatus: "paid",
      // The detail already holds this; the list does not pass it and lets
      // pricingSummaryForOrder recompute it. The rows below must still match.
      orderMoney: deriveOmsOrderMoney(order, [orderItems[0]!]),
    });

    const list = buildOmsOrderRowCore({
      order,
      activeHoldCount: 0,
      paymentIntents,
      paymentAttempts,
      identity,
      orderItems: orderItems.filter((item) => item.order_id === order.id),
      inventoryReservations: inventoryReservations.filter((row) => row.order_id === order.id),
      fulfillmentOrders: fulfillmentOrders.filter((row) => row.order_id === order.id),
      fulfillmentOperations,
      shipmentExternalRefs: shipmentExternalRefs.filter((row) => row.order_id === order.id),
      dispatchRefs,
      statusEvidence,
      releasedProviderExceptionHolds: releasedProviderExceptionHolds.filter((row) => row.order_id === order.id),
      accountingInvoice: accountingInvoices.find((row) => row.order_id === order.id) ?? null,
      accountingOutbox,
      subscriptionCycleStatus: "paid",
    });

    expect(list.row).toEqual(detail.row);
    expect(list.paymentStatus).toBe(detail.paymentStatus);
    expect(list.inventory).toEqual(detail.inventory);
    expect(list.accounting).toEqual(detail.accounting);
    expect(list.fulfillmentEligibility).toEqual(detail.fulfillmentEligibility);
  });

  // Provider attempts are detail-only evidence. They must reach providerEvidence
  // and must not move any field the queue row projects, which is what makes the
  // list's omission of them behaviour-preserving rather than a divergence.
  it("confines provider attempts to the fulfillment evidence the list never projects", () => {
    const base = {
      order,
      activeHoldCount: 0,
      paymentIntents: [paymentIntents[0]!],
      paymentAttempts,
      identity,
      orderItems: [orderItems[0]!],
      inventoryReservations: [inventoryReservations[0]!],
      fulfillmentOrders: [fulfillmentOrders[0]!],
      fulfillmentOperations,
      shipmentExternalRefs: [shipmentExternalRefs[0]!],
      dispatchRefs,
      statusEvidence,
      accountingInvoice: null,
      accountingOutbox: [],
      subscriptionCycleStatus: null,
    };
    const without = buildOmsOrderRowCore(base);
    const with_ = buildOmsOrderRowCore({
      ...base,
      providerAttempts: [{ fulfillment_order_id: shipmentId, provider_kind: "dispatch-provider", status: "failed", provider_tracking_id: null, error: { reason: "boom" }, created_at: "2026-06-05T11:30:00+00:00" }],
    });

    expect(with_.row).toEqual(without.row);
    expect(with_.fulfillment.providerEvidence.length).toBe(without.fulfillment.providerEvidence.length + 1);
  });
});

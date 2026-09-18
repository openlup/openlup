import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readCustomerOrderDetail as readCustomerOrderDetailFromStore,
  readCustomerOrderSummaries as readCustomerOrderSummariesFromStore,
} from "./customerOrderHistoryReadModels.js";
import { createSupabaseCustomerOrderHistoryReadStore } from "../../adapters/supabase/customerOrderHistoryReadStore.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";

function readCustomerOrderDetail(
  customerClient: SupabaseClient,
  serviceClient: SupabaseClient,
  ownerId: string,
  targetOrderId: string,
) {
  return readCustomerOrderDetailFromStore(
    createSupabaseCustomerOrderHistoryReadStore(customerClient, serviceClient),
    ownerId,
    targetOrderId,
  );
}

function readCustomerOrderSummaries(
  customerClient: SupabaseClient,
  serviceClient: SupabaseClient,
  ownerId: string,
  limit: number,
) {
  return readCustomerOrderSummariesFromStore(
    createSupabaseCustomerOrderHistoryReadStore(customerClient, serviceClient),
    ownerId,
    limit,
  );
}

describe("customer order history read model", () => {
  it.each([
    {
      name: "no discount",
      discount: 0,
      shippingGross: 0,
      shippingDiscount: 0,
      effective: 10_000,
      total: 10_000,
    },
    {
      name: "product discount",
      discount: 1_000,
      shippingGross: 0,
      shippingDiscount: 0,
      effective: 9_000,
      total: 9_000,
    },
    {
      name: "paid shipping",
      discount: 0,
      shippingGross: 1_500,
      shippingDiscount: 0,
      effective: 10_000,
      total: 11_500,
    },
    {
      name: "free shipping",
      discount: 0,
      shippingGross: 1_500,
      shippingDiscount: 1_500,
      effective: 10_000,
      total: 10_000,
    },
  ])("keeps the customer.orders.v2 detail DTO exact for $name", async (fixture) => {
    const result = await readCustomerOrderDetail(
      supabaseClient({
        commerce_orders: [canonicalOrder(fixture)],
        commerce_order_items: [canonicalLine(fixture)],
      }),
      emptyServiceClient(),
      clientId,
      orderId,
    );

    expect(result).toEqual({
      contractVersion: "customer.orders.v2",
      order: {
        orderId,
        orderRef: `order_${orderId}`,
        orderNumber: "OPENLUP-1001",
        subscriptionId: null,
        status: "paid",
        paymentStatus: null,
        fulfillmentStatus: null,
        // Additive, customer-safe projection; no provider or hold metadata enters
        // this exact DTO contract.
        customerFulfillmentStep: "paid",
        total: money(fixture.total),
        trackingNumber: null,
        trackingNumbers: [],
        trackingUrl: null,
        carrierKind: null,
        service: null,
        trackingReferences: [],
        trackingTimeline: [],
        deliverySelection: null,
        invoice: null,
        invoiceDocuments: [],
        invoiceRequestStatus: "not_requested",
        createdAt: "2026-06-16T10:00:00+00:00",
        updatedAt: "2026-06-16T10:01:00+00:00",
        subtotal: money(10_000),
        discount: money(fixture.discount),
        // customer.orders.v2 has no shippingDiscount field, so shipping remains
        // the effective delivery charge and closes the header equation.
        shipping: money(fixture.shippingGross - fixture.shippingDiscount),
        tax: money(0),
        lines: [{
          lineId: "33333333-3333-4333-8333-333333333333",
          skuId: null,
          title: "Testowa karma 400g",
          quantity: 2,
          unitPrice: money(5_000),
          // This is deliberately catalog money even when an order-level promo
          // was allocated to the position.
          total: money(10_000),
          recipeName: null,
          variantName: null,
          productSlug: null,
          flavourSlug: null,
          displayLabel: null,
          accentColor: null,
          listTotal: null,
          discount: null,
        }],
        fulfillment: null,
      },
    });
  });

  it("returns payment-started orders before they are paid", async () => {
    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          {
            id: orderId,
            order_number: null,
            status: "payment_pending",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-16T10:00:00+00:00",
            updated_at: "2026-06-16T10:01:00+00:00",
          },
        ],
      }),
      supabaseClient({
        commerce_payments: [{ order_id: orderId, status: "processing", updated_at: "2026-06-16T10:01:00+00:00" }],
        commerce_fulfillment_orders: [],
        shipment_external_refs: [],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders).toEqual([
      expect.objectContaining({
        orderId,
        status: "payment_pending",
        paymentStatus: "processing",
        fulfillmentStatus: null,
        invoiceRequestStatus: "not_requested",
      }),
    ]);
  });

  it("marks B2B invoice requests as preparing until a real invoice row exists", async () => {
    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          {
            id: orderId,
            order_number: "OPENLUP-1001",
            status: "paid",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-16T10:00:00+00:00",
            updated_at: "2026-06-16T10:01:00+00:00",
            metadata: {
              invoiceBuyerSnapshot: {
                taxId: "1234563218",
                companyName: "Example Company Sp. z o.o.",
              },
            },
          },
        ],
      }),
      supabaseClient({
        commerce_payments: [{ order_id: orderId, status: "succeeded", updated_at: "2026-06-16T10:01:00+00:00" }],
        commerce_fulfillment_orders: [],
        shipment_external_refs: [],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders[0]).toMatchObject({
      invoice: null,
      invoiceRequestStatus: "preparing",
    });
  });

  it("projects customer-safe carrier tracking refs without depending on OmniPack credentials", async () => {
    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          {
            id: orderId,
            order_number: "1001",
            status: "fulfillment_pending",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-16T10:00:00+00:00",
            updated_at: "2026-06-16T10:01:00+00:00",
          },
        ],
      }),
      supabaseClient({
        commerce_payments: [{ order_id: orderId, status: "succeeded", updated_at: "2026-06-16T10:01:00+00:00" }],
        commerce_fulfillment_orders: [{
          id: "33333333-3333-4333-8333-333333333333",
          order_id: orderId,
          client_id: clientId,
          status: "shipped",
          provider_kind: "omnipack",
          updated_at: "2026-06-16T10:04:00+00:00",
        }],
        shipment_external_refs: [
          {
            order_id: orderId,
            provider_kind: "omnipack",
            provider_tracking_id: "INPOST-1",
            tracking_url: "https://inpost.example/INPOST-1",
            carrier_kind: "inpost",
            service: "parcel_locker",
            created_at: "2026-06-16T10:02:00+00:00",
            updated_at: "2026-06-16T10:03:00+00:00",
          },
          {
            order_id: orderId,
            provider_kind: "dhl",
            provider_tracking_id: "DHL-1",
            tracking_url: "https://dhl.example/DHL-1",
            carrier_kind: "dhl",
            service: "courier",
            created_at: "2026-06-16T10:01:00+00:00",
            updated_at: "2026-06-16T10:02:00+00:00",
          },
        ],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders[0]).toMatchObject({
      trackingNumber: "INPOST-1",
      trackingNumbers: ["INPOST-1", "DHL-1"],
      trackingUrl: "https://inpost.example/INPOST-1",
      carrierKind: "inpost",
      service: "parcel_locker",
      trackingReferences: [
        {
          providerKind: "omnipack",
          trackingNumber: "INPOST-1",
          trackingUrl: "https://inpost.example/INPOST-1",
          carrierKind: "inpost",
          service: "parcel_locker",
        },
        {
          providerKind: "dhl",
          trackingNumber: "DHL-1",
          trackingUrl: "https://dhl.example/DHL-1",
          carrierKind: "dhl",
          service: "courier",
        },
      ],
    });
  });

  // The customer-visible half of the replacement wave. Before attribution the account page took
  // whichever active reference the order happened to carry, so a customer waiting on a replacement
  // could be shown - and could click - the tracking number of the parcel that was lost.
  it("shows the current parcel's tracking once an order carries a replacement", async () => {
    const original = "33333333-3333-4333-8333-333333333333";
    const replacement = "44444444-4444-4444-8444-444444444444";
    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          {
            id: orderId,
            order_number: "1001",
            status: "fulfillment_pending",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-16T10:00:00+00:00",
            updated_at: "2026-06-16T10:01:00+00:00",
          },
        ],
      }),
      supabaseClient({
        commerce_payments: [{ order_id: orderId, status: "succeeded", updated_at: "2026-06-16T10:01:00+00:00" }],
        commerce_fulfillment_orders: [
          { id: original, order_id: orderId, client_id: clientId, sequence_no: 0, status: "exception", updated_at: "2026-06-16T10:04:00+00:00" },
          { id: replacement, order_id: orderId, client_id: clientId, sequence_no: 1, status: "shipped", updated_at: "2026-06-18T10:04:00+00:00" },
        ],
        shipment_external_refs: [
          {
            order_id: orderId,
            fulfillment_order_id: original,
            provider_kind: "test_carrier",
            provider_tracking_id: "TRACK-LOST",
            tracking_url: "https://carrier.example/TRACK-LOST",
            created_at: "2026-06-16T10:02:00+00:00",
            updated_at: "2026-06-16T10:03:00+00:00",
          },
          {
            order_id: orderId,
            fulfillment_order_id: replacement,
            provider_kind: "test_carrier",
            provider_tracking_id: "TRACK-CURRENT",
            tracking_url: "https://carrier.example/TRACK-CURRENT",
            created_at: "2026-06-18T10:02:00+00:00",
            updated_at: "2026-06-18T10:03:00+00:00",
          },
        ],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders[0]).toMatchObject({
      trackingNumber: "TRACK-CURRENT",
      trackingNumbers: ["TRACK-CURRENT"],
      trackingUrl: "https://carrier.example/TRACK-CURRENT",
    });
    // The lost parcel's number is not merely deprioritised: it is not the customer's any more.
    expect(result.orders[0].trackingNumbers).not.toContain("TRACK-LOST");
    expect(result.orders[0].fulfillmentStatus).toBe("shipped");
  });

  it("projects an exactly linked recovery without exposing the released-hold metadata", async () => {
    const fulfillmentOrderId = "33333333-3333-4333-8333-333333333333";
    const exceptionAt = "2026-08-04T10:00:00+00:00";
    const recoveryAt = "2026-08-04T10:01:00+00:00";
    const result = await readCustomerOrderSummaries(
      supabaseClient({ commerce_orders: [canonicalOrder({ discount: 0, shippingGross: 0, shippingDiscount: 0, effective: 10_000, total: 10_000 })] }),
      supabaseClient({
        commerce_payments: [],
        commerce_fulfillment_orders: [{ id: fulfillmentOrderId, order_id: orderId, client_id: clientId, status: "exception", provider_kind: "omnipack" }],
        shipment_external_refs: [],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [
          { id: "exception-evidence", order_id: orderId, fulfillment_order_id: fulfillmentOrderId, provider_status: "SUSPENDED", local_status: "exception", evidence_kind: "reconciliation", occurred_at: exceptionAt },
          { id: "recovery-evidence", order_id: orderId, fulfillment_order_id: fulfillmentOrderId, provider_status: "AWAITING_COURIER", local_status: "packed", evidence_kind: "reconciliation", occurred_at: recoveryAt },
        ],
        commerce_order_holds: [{
          order_id: orderId,
          status: "released",
          reason: "fulfillment_exception",
          created_by: null,
          released_by: null,
          metadata: {
            source: "commerce.fulfillment.omnipack_provider_exception",
            autoReleased: true,
            autoReleaseSource: "commerce.fulfillment.omnipack_provider_exception_healed",
            autoReleaseProof: "provider_recovered",
            autoReleaseEvidence: {
              fulfillmentOrderId,
              statusEvidenceId: "recovery-evidence",
              localStatus: "packed",
              occurredAt: recoveryAt,
              clearedStatusEvidenceId: "exception-evidence",
              clearedProviderStatus: "SUSPENDED",
              clearedOccurredAt: exceptionAt,
            },
          },
        }],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders[0]).toMatchObject({
      fulfillmentStatus: "exception",
      customerFulfillmentStep: "packing",
      trackingTimeline: [
        expect.objectContaining({ eventType: "packed" }),
        expect.objectContaining({ eventType: "exception" }),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/autoRelease|statusEvidenceId|clearedStatusEvidenceId/i);
  });

  it("reads the exact recovery pair even when the bounded evidence feed omits it", async () => {
    const fulfillmentOrderId = "33333333-3333-4333-8333-333333333333";
    const exceptionAt = "2026-08-04T10:00:00+00:00";
    const recoveryAt = "2026-08-04T10:01:00+00:00";
    const noise = Array.from({ length: 200 }, (_, index) => ({
      id: `newer-${index}`, order_id: orderId, fulfillment_order_id: fulfillmentOrderId,
      provider_status: "AWAITING_COURIER", local_status: "packed", occurred_at: `2026-08-05T10:${String(index % 60).padStart(2, "0")}:00+00:00`,
    }));
    const result = await readCustomerOrderSummaries(
      supabaseClient({ commerce_orders: [canonicalOrder({ discount: 0, shippingGross: 0, shippingDiscount: 0, effective: 10_000, total: 10_000 })] }),
      supabaseClient({
        commerce_payments: [],
        commerce_fulfillment_orders: [{ id: fulfillmentOrderId, order_id: orderId, client_id: clientId, status: "exception", provider_kind: "omnipack" }],
        shipment_external_refs: [], commerce_fulfillment_operations: [],
        omnipack_status_evidence: [...noise,
          { id: "exception-evidence", order_id: orderId, fulfillment_order_id: fulfillmentOrderId, provider_status: "SUSPENDED", local_status: "exception", occurred_at: exceptionAt },
          { id: "recovery-evidence", order_id: orderId, fulfillment_order_id: fulfillmentOrderId, provider_status: "AWAITING_COURIER", local_status: "packed", occurred_at: recoveryAt },
        ],
        commerce_order_holds: [releasedProviderExceptionHold(fulfillmentOrderId, exceptionAt, recoveryAt)],
        accounting_invoices: [], accounting_invoice_delivery_outbox: [],
      }), clientId, 10,
    );
    expect(result.orders[0]?.customerFulfillmentStep).toBe("packing");
  });

  it("keeps a recovered order exceptional when a later active hold exists", async () => {
    const fulfillmentOrderId = "33333333-3333-4333-8333-333333333333";
    const exceptionAt = "2026-08-04T10:00:00+00:00";
    const recoveryAt = "2026-08-04T10:01:00+00:00";
    const result = await readCustomerOrderSummaries(
      supabaseClient({ commerce_orders: [canonicalOrder({ discount: 0, shippingGross: 0, shippingDiscount: 0, effective: 10_000, total: 10_000 })] }),
      supabaseClient({
        commerce_payments: [],
        commerce_fulfillment_orders: [{ id: fulfillmentOrderId, order_id: orderId, client_id: clientId, status: "exception", provider_kind: "omnipack" }],
        shipment_external_refs: [], commerce_fulfillment_operations: [],
        omnipack_status_evidence: [
          { id: "exception-evidence", order_id: orderId, fulfillment_order_id: fulfillmentOrderId, provider_status: "SUSPENDED", local_status: "exception", occurred_at: exceptionAt },
          { id: "recovery-evidence", order_id: orderId, fulfillment_order_id: fulfillmentOrderId, provider_status: "AWAITING_COURIER", local_status: "packed", occurred_at: recoveryAt },
        ],
        commerce_order_holds: [
          releasedProviderExceptionHold(fulfillmentOrderId, exceptionAt, recoveryAt),
          { order_id: orderId, status: "active", reason: "manual_support", created_by: "operator", released_by: null, metadata: {} },
        ],
        accounting_invoices: [], accounting_invoice_delivery_outbox: [],
      }), clientId, 10,
    );
    expect(result.orders[0]?.customerFulfillmentStep).toBe("exception");
  });

  it.each(["refunded", "cancelled"])("never tells the customer a %s order was delivered", async (orderStatus) => {
    const orders = ordersReadingStatus(orderStatus);

    // The orders list hides `cancelled` but NOT `refunded`, so the list surface is
    // reachable only for the refunded order. The order-detail read applies no
    // status filter, so both statuses are reachable there.
    const list = await readCustomerOrderSummaries(orders, deliveredEvidenceServices("cancelled"), clientId, 10);
    expect(list.orders[0]?.customerFulfillmentStep).toBe(orderStatus === "refunded" ? "cancelled" : undefined);

    const detail = await readCustomerOrderDetail(orders, deliveredEvidenceServices("cancelled"), clientId, orderId);
    expect(detail?.order.customerFulfillmentStep).toBe("cancelled");
    // The carrier's report is a fact and stays in the sanitized timeline; only the
    // headline step is capped.
    expect(detail?.order.trackingTimeline).toEqual([{
      eventType: "delivered", label: "Dostarczono", occurredAt: deliveredEvidenceAt, source: "reconciliation",
    }]);
  });

  it("keeps ranking carrier evidence for an order that is not terminal", async () => {
    const result = await readCustomerOrderSummaries(
      ordersReadingStatus("paid"), deliveredEvidenceServices("handed_over"), clientId, 10,
    );
    expect(result.orders[0]?.customerFulfillmentStep).toBe("delivered");
  });

  it("projects selected InPost pickup delivery evidence before tracking exists", async () => {
    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          {
            id: orderId,
            order_number: "1002",
            status: "paid",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-16T10:00:00+00:00",
            updated_at: "2026-06-16T10:01:00+00:00",
            metadata: {
              runtimeFinalize: {
                selectedDelivery: {
                  kind: "parcel-locker",
                  deliveryKind: "parcel-locker",
                  providerKind: "omnipack",
                  carrierKind: "inpost",
                  carrierCode: "INPOST",
                  serviceCode: "INPOST_LOCKER_STANDARD",
                  pickupPoint: {
                    id: "WAW01A",
                    name: "Paczkomat WAW01A",
                    address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
                  },
                },
              },
            },
          },
        ],
      }),
      supabaseClient({
        commerce_payments: [{ order_id: orderId, status: "succeeded", updated_at: "2026-06-16T10:01:00+00:00" }],
        commerce_fulfillment_orders: [],
        shipment_external_refs: [],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders[0]).toMatchObject({
      trackingReferences: [],
      deliverySelection: {
        deliveryKind: "parcel-locker",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: { id: "WAW01A", name: "Paczkomat WAW01A" },
      },
    });
  });

  it("hides terminal cancelled/expired orders but keeps recoverable ones", async () => {
    const order = (id: string, status: string) => ({
      id,
      order_number: null,
      status,
      currency: "PLN",
      subtotal_cents: 4900,
      discount_cents: 0,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 4900,
      created_at: "2026-06-16T10:00:00+00:00",
      updated_at: "2026-06-16T10:01:00+00:00",
    });
    const keepPending = "22222222-2222-4222-8222-000000000001";
    const keepPaid = "22222222-2222-4222-8222-000000000002";
    const dropCancelled = "22222222-2222-4222-8222-000000000003";
    const dropExpired = "22222222-2222-4222-8222-000000000004";

    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          order(keepPending, "pending_payment"),
          order(keepPaid, "paid"),
          order(dropCancelled, "cancelled"),
          order(dropExpired, "expired"),
        ],
      }),
      supabaseClient({
        commerce_payments: [],
        commerce_fulfillment_orders: [],
        shipment_external_refs: [],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders.map((o) => o.orderId)).toEqual([keepPending, keepPaid]);
  });

  it("maps subscription_id (null for one-time, uuid for subscription orders)", async () => {
    const subId = "99999999-9999-4999-8999-999999999999";
    const result = await readCustomerOrderSummaries(
      supabaseClient({
        commerce_orders: [
          {
            id: orderId,
            order_number: null,
            subscription_id: subId,
            status: "pending_payment",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-16T10:00:00+00:00",
            updated_at: "2026-06-16T10:01:00+00:00",
          },
          {
            id: "22222222-2222-4222-8222-00000000aaaa",
            order_number: null,
            subscription_id: null,
            status: "pending_payment",
            currency: "PLN",
            subtotal_cents: 4900,
            discount_cents: 0,
            shipping_cents: 0,
            tax_cents: 0,
            total_cents: 4900,
            created_at: "2026-06-15T10:00:00+00:00",
            updated_at: "2026-06-15T10:01:00+00:00",
          },
        ],
      }),
      supabaseClient({
        commerce_payments: [],
        commerce_fulfillment_orders: [],
        shipment_external_refs: [],
        commerce_fulfillment_operations: [],
        omnipack_status_evidence: [],
        accounting_invoices: [],
        accounting_invoice_delivery_outbox: [],
      }),
      clientId,
      10,
    );

    expect(result.orders.find((o) => o.orderId === orderId)?.subscriptionId).toBe(subId);
    expect(
      result.orders.find((o) => o.orderId === "22222222-2222-4222-8222-00000000aaaa")?.subscriptionId,
    ).toBeNull();
  });
});

describe("customer order history when an order holds a replacement parcel", () => {
  // The rule: the parcel that currently represents the order is the highest
  // `sequence_no`, tie-broken by `id`. With one row that is the row itself, which is why
  // the customer's order page is unchanged for every order that exists today.
  const original = {
    id: "44444444-4444-4444-8444-000000000000",
    order_id: orderId,
    client_id: clientId,
    sequence_no: 0,
    status: "exception",
    provider_kind: "omnipack",
    updated_at: "2026-06-16T10:04:00+00:00",
  };
  const replacement = {
    id: "44444444-4444-4444-8444-000000000001",
    order_id: orderId,
    client_id: clientId,
    sequence_no: 1,
    status: "shipped",
    provider_kind: "omnipack",
    updated_at: "2026-06-16T11:04:00+00:00",
  };

  it("shows the only parcel when the order holds one fulfilment row", async () => {
    const result = await readCustomerOrderDetail(
      supabaseClient({ commerce_orders: [canonicalOrder(zeroDiscount)], commerce_order_items: [canonicalLine(zeroDiscount)] }),
      fulfillmentServices([original]),
      clientId,
      orderId,
    );

    expect(result?.order.fulfillment).toMatchObject({
      fulfillmentOrderId: original.id,
      status: "exception",
      updatedAt: "2026-06-16T10:04:00+00:00",
    });
    expect(result?.order.fulfillmentStatus).toBe("exception");
  });

  it.each([
    { name: "replacement read last", rows: [original, replacement] },
    { name: "replacement read first", rows: [replacement, original] },
  ])("shows the replacement parcel whatever order the rows arrive in ($name)", async ({ rows }) => {
    const result = await readCustomerOrderDetail(
      supabaseClient({ commerce_orders: [canonicalOrder(zeroDiscount)], commerce_order_items: [canonicalLine(zeroDiscount)] }),
      fulfillmentServices(rows),
      clientId,
      orderId,
    );

    expect(result?.order.fulfillment).toMatchObject({
      fulfillmentOrderId: replacement.id,
      status: "shipped",
      updatedAt: "2026-06-16T11:04:00+00:00",
    });
    expect(result?.order.fulfillmentStatus).toBe("shipped");
  });

  it("breaks a same-sequence tie by id rather than by read order", async () => {
    const result = await readCustomerOrderDetail(
      supabaseClient({ commerce_orders: [canonicalOrder(zeroDiscount)], commerce_order_items: [canonicalLine(zeroDiscount)] }),
      fulfillmentServices([
        { ...replacement, sequence_no: 0 },
        { ...original, sequence_no: 0 },
      ]),
      clientId,
      orderId,
    );

    expect(result?.order.fulfillment).toMatchObject({ fulfillmentOrderId: replacement.id, status: "shipped" });
  });

  // The read models resolve the parcel themselves, but `commerce_fulfillment_orders` is
  // also handed unchanged to collapse sites this lane does not own (the recovery map),
  // which take the last row per order. Asking the database for the canonical order is
  // what makes those land on the same parcel.
  it("asks the database for the rows in resolution order, with the ordinal selected", async () => {
    const recorded: RecordedQuery[] = [];
    await readCustomerOrderDetail(
      supabaseClient({ commerce_orders: [canonicalOrder(zeroDiscount)], commerce_order_items: [canonicalLine(zeroDiscount)] }),
      fulfillmentServices([original, replacement], recorded),
      clientId,
      orderId,
    );

    const fulfillmentRead = recorded.find((call) => call.table === "commerce_fulfillment_orders");
    expect(fulfillmentRead?.select).toContain("sequence_no");
    expect(fulfillmentRead?.orders).toEqual([
      ["sequence_no", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });
});

const zeroDiscount: CanonicalFixture = {
  discount: 0,
  shippingGross: 0,
  shippingDiscount: 0,
  effective: 10_000,
  total: 10_000,
};

function fulfillmentServices(
  fulfillmentOrders: Record<string, unknown>[],
  recorded: RecordedQuery[] = [],
): SupabaseClient {
  return supabaseClient({
    commerce_payments: [],
    commerce_fulfillment_orders: fulfillmentOrders,
    shipment_external_refs: [],
    commerce_fulfillment_operations: [],
    omnipack_status_evidence: [],
    commerce_order_holds: [],
    accounting_invoices: [],
    accounting_invoice_delivery_outbox: [],
  }, recorded);
}

// Recorded query shape, so a test can assert what the store *asks the database for*.
// `order` stays a no-op on the fixture rows: leaving them in fixture order is what makes
// the read models prove they resolve a parcel themselves rather than trusting read order.
type RecordedQuery = { table: string; select?: string; orders: unknown[][] };

function supabaseClient(
  rows: Record<string, Record<string, unknown>[]>,
  recorded: RecordedQuery[] = [],
): SupabaseClient {
  return {
    from(table: string) {
      let result = rows[table] ?? [];
      const call: RecordedQuery = { table, orders: [] };
      recorded.push(call);
      const builder = {
        select: (columns?: string) => {
          call.select = columns;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          if (result.every((row) => column in row)) result = result.filter((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          result = result.filter((row) => values.includes(row[column]));
          return builder;
        },
        is: () => builder,
        // Honors `.not("col","in","(a,b)")` so status-exclusion filters are exercised.
        not: (column: string, op: string, value: unknown) => {
          if (op === "in" && typeof value === "string") {
            const excluded = new Set(
              value.replace(/^\(|\)$/g, "").split(",").map((part) => part.trim()),
            );
            result = result.filter((row) => !excluded.has(String(row[column])));
          }
          return builder;
        },
        order: (...args: unknown[]) => {
          call.orders.push(args);
          return builder;
        },
        limit: (count: number) => {
          result = result.slice(0, count);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: result[0] ?? null, error: null }),
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: result, error: null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const deliveredEvidenceAt = "2026-07-17T13:00:00+00:00";
const trackedFulfillmentOrderId = "33333333-3333-4333-8333-333333333333";

function ordersReadingStatus(status: string) {
  return supabaseClient({
    commerce_orders: [{
      ...canonicalOrder({ discount: 0, shippingGross: 0, shippingDiscount: 0, effective: 10_000, total: 10_000 }),
      status,
    }],
  });
}

// One delivered status-evidence row against a fulfillment in the given state. The
// row deliberately carries no raw carrier vocabulary: `local_status` alone is what
// the customer projection reads.
function deliveredEvidenceServices(fulfillmentStatus: string) {
  return supabaseClient({
    commerce_payments: [],
    commerce_fulfillment_orders: [{ id: trackedFulfillmentOrderId, order_id: orderId, client_id: clientId, status: fulfillmentStatus }],
    shipment_external_refs: [], commerce_fulfillment_operations: [],
    omnipack_status_evidence: [{
      id: "delivered-evidence", order_id: orderId, fulfillment_order_id: trackedFulfillmentOrderId,
      local_status: "delivered", evidence_kind: "reconciliation", occurred_at: deliveredEvidenceAt,
    }],
    commerce_order_holds: [],
    accounting_invoices: [], accounting_invoice_delivery_outbox: [],
  });
}

function releasedProviderExceptionHold(fulfillmentOrderId: string, exceptionAt: string, recoveryAt: string) {
  return {
    order_id: orderId, status: "released", reason: "fulfillment_exception", created_by: null, released_by: null,
    metadata: {
      source: "commerce.fulfillment.omnipack_provider_exception", autoReleased: true,
      autoReleaseSource: "commerce.fulfillment.omnipack_provider_exception_healed", autoReleaseProof: "provider_recovered",
      autoReleaseEvidence: { fulfillmentOrderId, statusEvidenceId: "recovery-evidence", localStatus: "packed", occurredAt: recoveryAt,
        clearedStatusEvidenceId: "exception-evidence", clearedProviderStatus: "SUSPENDED", clearedOccurredAt: exceptionAt },
    },
  };
}

interface CanonicalFixture {
  discount: number;
  shippingGross: number;
  shippingDiscount: number;
  effective: number;
  total: number;
}

function canonicalOrder(fixture: CanonicalFixture): Record<string, unknown> {
  return {
    id: orderId,
    client_id: clientId,
    order_number: "OPENLUP-1001",
    subscription_id: null,
    status: "paid",
    currency: "PLN",
    subtotal_cents: 10_000,
    discount_cents: fixture.discount,
    shipping_cents: fixture.shippingGross,
    shipping_discount_cents: fixture.shippingDiscount,
    tax_cents: 0,
    total_cents: fixture.total,
    created_at: "2026-06-16T10:00:00+00:00",
    updated_at: "2026-06-16T10:01:00+00:00",
    metadata: {},
  };
}

function canonicalLine(fixture: CanonicalFixture): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    order_id: orderId,
    sku_id: null,
    quantity: 2,
    unit_price_cents: 5_000,
    total_cents: 10_000,
    discount_allocated_cents: fixture.discount,
    effective_total_cents: fixture.effective,
    effective_net_cents: fixture.effective,
    vat_rate_bps: 0,
    product_snapshot: {},
    variant_snapshot: { title: "Testowa karma 400g" },
  };
}

function emptyServiceClient(): SupabaseClient {
  return supabaseClient({
    commerce_payments: [],
    commerce_fulfillment_orders: [],
    shipment_external_refs: [],
    commerce_fulfillment_operations: [],
    omnipack_status_evidence: [],
    accounting_invoices: [],
    accounting_invoice_delivery_outbox: [],
  });
}

function money(amountMinor: number) {
  return { amountMinor, currency: "PLN" } as const;
}

import { describe, expect, it } from "vitest";
import { getCommerceOmsOrderDetail } from "./readQueries.js";
import { FakeOmsClient } from "./readQueriesTestKit.js";
import {
  communicationDelivery,
  order,
  orderItem,
  paymentIntent,
  reservation,
} from "./readQueries.fixtures.js";

describe("supabase commerce OMS fulfillment debug read query", () => {
  it("hydrates the debug packet from OmniPack provider and communication evidence", async () => {
    const paidOrder = order("42222222-2222-4222-8222-222222222227", "OMS-1005");
    const item = {
      ...orderItem(paidOrder.id, "42222222-2222-4222-8222-222222222228"),
      sku_id: "42222222-2222-4222-8222-222222222229",
    };
    const dispatched = {
      ...communicationDelivery(paidOrder.id),
      purpose: "shipment_dispatched",
      template_slug: "commerce-shipment-dispatched",
      trigger_event: "commerce.shipment.dispatched",
    };
    const fulfillmentOrderId = "52222222-2222-4222-8222-222222222227";
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        commerce_orders: [paidOrder],
        commerce_payment_intents: [paymentIntent(paidOrder.id)],
        commerce_payment_attempts: [],
        commerce_payment_state_transitions: [],
        commerce_order_holds: [],
        commerce_order_operations: [],
        commerce_order_items: [item],
        subscription_cycles: [],
        inventory_reservations: [reservation(paidOrder.id, item.id)],
        commerce_fulfillment_orders: [{
          id: fulfillmentOrderId,
          order_id: paidOrder.id,
          status: "in_transit",
          provider_kind: "omnipack",
        }],
        commerce_fulfillment_operations: [],
        shipment_external_refs: [{
          order_id: paidOrder.id,
          provider_kind: "omnipack",
          provider_tracking_id: "TRACK-1005",
          tracking_url: null,
          carrier_kind: "dpd",
          service: "courier",
          active: true,
          updated_at: "2026-06-05T10:35:00+00:00",
        }],
        fulfillment_provider_stock_current: [{
          provider_kind: "omnipack",
          sku: "OPENLUP-OMS-1005",
          catalog_sku_id: item.sku_id,
          provider_for_sale_quantity: 10,
          provider_total_quantity: 12,
          last_synced_at: "2026-06-05T10:30:00+00:00",
          stale_after: "2099-06-05T16:30:00+00:00",
        }],
        omnipack_dispatch_refs: [{
          fulfillment_order_id: fulfillmentOrderId,
          provider_order_id: "provider-order-1005",
          dispatch_mode: "stage",
          status: "created",
          created_at: "2026-06-05T10:20:00+00:00",
        }],
        omnipack_status_evidence: [{
          fulfillment_order_id: fulfillmentOrderId,
          provider_status: "shipped",
          local_status: "in_transit",
          evidence_kind: "webhook",
          occurred_at: "2026-06-05T10:34:00+00:00",
        }],
        commerce_fulfillment_provider_attempts: [],
        inbound_provider_events: [{
          id: "evt-1005",
          provider: "omnipack",
          provider_event_id: "order.shipped:provider-order-1005",
          event_type: "order.shipped",
          processing_status: "processed",
          payload: { providerOrderId: "provider-order-1005", orderNumber: "OMS-1005" },
          error: null,
          created_at: "2026-06-05T10:34:00+00:00",
        }],
        clients: [],
        pets: [],
        addresses: [],
        accounting_invoices: [],
        accounting_invoice_issue_outbox: [],
        communication_email_deliveries: [dispatched],
      },
    });

    const response = await getCommerceOmsOrderDetail(client, { orderId: paidOrder.id });

    expect(response?.order.fulfillmentDebug).toMatchObject({
      severity: "ok",
      nextAction: "wait",
      blockers: [],
    });
    expect(response?.order.fulfillmentDebug.steps.map((step) => [step.key, step.status])).toContainEqual([
      "communication",
      "ok",
    ]);
    expect(client.tablesRead).toContain("inbound_provider_events");
  });
});

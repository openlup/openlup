import { describe, expect, it } from "vitest";

import { buildCustomerJourneySnapshotFromRows } from "./customerJourneySnapshot.js";

const orderId = "22222222-2222-4222-8222-222222222222";
const clientId = "11111111-1111-4111-8111-111111111111";
const fulfillmentOrderId = "33333333-3333-4333-8333-333333333333";
const subscriptionId = "44444444-4444-4444-8444-444444444444";

describe("customer journey snapshot read model", () => {
  it("resolves SHIPPING reconciliation as customer in transit with tracking and webhook gap", () => {
    const snapshot = buildCustomerJourneySnapshotFromRows({
      lookup: { orderNumber: "OPENLUP-0F50280B", pageSize: 10 },
      client: {
        id: clientId,
        email: "operator@example.invalid",
        first_name: "Bartek",
        last_name: "Roszkowski",
        lifecycle_stage: "customer",
        auth_user_id: "auth-1",
        created_at: "2026-07-13T10:00:00.000Z",
      },
      testers: [],
      waitlist: [],
      orders: [{
        id: orderId,
        order_number: "OPENLUP-0F50280B",
        client_id: clientId,
        status: "paid",
        mode: "one_time",
        subscription_id: null,
        created_at: "2026-07-13T11:00:00.000Z",
      }],
      subscriptions: [{
        id: subscriptionId,
        client_id: clientId,
        status: "active",
        next_cycle_at: "2026-08-13T11:00:00.000Z",
      }],
      cycles: [{
        id: "55555555-5555-4555-8555-555555555555",
        subscription_id: subscriptionId,
        cycle_number: 1,
        status: "charged",
        order_id: orderId,
      }],
      paymentIntents: [{ id: "pi-1", order_id: orderId, status: "succeeded", created_at: "2026-07-13T11:01:00.000Z" }],
      paymentAttempts: [],
      paymentTransitions: [],
      fulfillmentOrders: [{
        id: fulfillmentOrderId,
        order_id: orderId,
        status: "in_transit",
        provider_kind: "omnipack",
      }],
      shipmentRefs: [{
        order_id: orderId,
        provider_kind: "omnipack",
        provider_tracking_id: "620999680605074433453432",
        active: true,
        updated_at: "2026-07-13T11:45:05.000Z",
      }],
      statusEvidence: [{
        fulfillment_order_id: fulfillmentOrderId,
        provider_status: "SHIPPING",
        provider_sub_status: "PICKED_UP",
        local_status: "in_transit",
        evidence_kind: "reconciliation",
        occurred_at: "2026-07-13T11:45:04.000Z",
      }],
      inboundEvents: [],
      outboxEvents: [{
        id: "outbox-1",
        aggregate_type: "commerce_order",
        aggregate_id: orderId,
        event_type: "commerce.shipment.dispatched",
        status: "processed",
        created_at: "2026-07-13T11:45:33.000Z",
      }],
      communicationDeliveries: [{
        id: "delivery-1",
        aggregate_type: "commerce_order",
        aggregate_id: orderId,
        template_slug: "commerce-shipment-dispatched",
        status: "delivered",
        provider_kind: "resend",
        queued_at: "2026-07-13T11:45:33.000Z",
        sent_at: "2026-07-13T11:45:34.000Z",
        delivered_at: "2026-07-13T11:45:37.000Z",
      }],
      recoveryTokens: [],
    });

    expect(snapshot.orders[0]).toMatchObject({
      customerStep: "transit",
      customerLabel: "W drodze",
      fulfillment: {
        status: "in_transit",
        providerKind: "omnipack",
      },
    });
    expect(snapshot.orders[0]?.customerAccountProjection).toMatchObject({
      trackingNumbers: ["620999680605074433453432"],
    });
    expect(snapshot.orders[0]?.communications[0]).toMatchObject({
      templateSlug: "commerce-shipment-dispatched",
      status: "delivered",
    });
    expect(snapshot.gaps).toContainEqual(expect.objectContaining({ code: "webhook_missing_reconciliation_present" }));
    expect(snapshot.subscriptions[0]?.cycles).toHaveLength(1);
    expect(snapshot.nextChecks).toEqual(expect.arrayContaining([
      expect.stringContaining("Ask provider for exact callback timestamp"),
    ]));
  });

  it("surfaces order draft and recovery evidence even without a paid order", () => {
    const snapshot = buildCustomerJourneySnapshotFromRows({
      lookup: { email: "lead@example.com", pageSize: 10 },
      client: { id: clientId, email: "lead@example.com", lifecycle_stage: "lead", created_at: "2026-07-13T09:00:00.000Z" },
      testers: [],
      waitlist: [],
      orders: [{ id: orderId, client_id: clientId, status: "pending_payment", created_at: "2026-07-13T09:05:00.000Z" }],
      subscriptions: [],
      cycles: [],
      paymentIntents: [],
      paymentAttempts: [],
      paymentTransitions: [],
      fulfillmentOrders: [],
      shipmentRefs: [],
      statusEvidence: [],
      inboundEvents: [],
      outboxEvents: [{
        id: "outbox-draft",
        aggregate_type: "commerce_order",
        aggregate_id: orderId,
        event_type: "commerce.order_draft.created",
        status: "processed",
        created_at: "2026-07-13T09:06:00.000Z",
      }],
      communicationDeliveries: [],
      recoveryTokens: [{
        id: "recovery-1",
        order_id: orderId,
        client_id: clientId,
        created_at: "2026-07-13T10:06:00.000Z",
        expires_at: "2026-07-14T10:06:00.000Z",
      }],
    });

    expect(snapshot.checkout.orderDrafts).toHaveLength(1);
    expect(snapshot.checkout.recoveryTokens[0]).toMatchObject({ recoveryTokenId: "recovery-1" });
    expect(JSON.stringify(snapshot)).not.toContain("token_hash");
  });
});

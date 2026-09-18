import { describe, expect, it } from "vitest";
import { buildCustomerJourneySnapshotFromRows } from "./customerJourneyRowsSnapshot.js";

describe("customer journey rows snapshot fallback builder", () => {
  it("produces a sanitized snapshot from row evidence", () => {
    const snapshot = buildCustomerJourneySnapshotFromRows({
      lookup: { email: "x@example.com", pageSize: 10 },
      client: { id: "client-1", email: "x@example.com", created_at: "2026-01-01T00:00:00.000Z" },
      orders: [],
      subscriptions: [],
      cycles: [],
      paymentIntents: [],
      paymentAttempts: [],
      paymentTransitions: [],
      fulfillmentOrders: [],
      shipmentRefs: [],
      statusEvidence: [],
      inboundEvents: [],
      outboxEvents: [],
      communicationDeliveries: [],
      recoveryTokens: [],
    });

    expect(snapshot.customer.email).toBe("x@example.com");
    expect(snapshot.timeline[0]).toMatchObject({ kind: "customer.created" });
  });

  it("projects current, legacy and provider-only CANCELLED evidence as exception", () => {
    const snapshot = buildCustomerJourneySnapshotFromRows({
      lookup: { email: "x@example.com", pageSize: 10 },
      client: { id: "client-1", email: "x@example.com" },
      orders: [
        { id: "order-exception", client_id: "client-1", status: "paid" },
        { id: "order-legacy", client_id: "client-1", status: "paid" },
        { id: "order-unknown", client_id: "client-1", status: "paid" },
      ],
      subscriptions: [],
      cycles: [],
      paymentIntents: [],
      paymentAttempts: [],
      paymentTransitions: [],
      fulfillmentOrders: [
        { id: "ful-exception", order_id: "order-exception", status: "created" },
        { id: "ful-legacy", order_id: "order-legacy", status: "created" },
        { id: "ful-unknown", order_id: "order-unknown", status: "created" },
      ],
      shipmentRefs: [],
      statusEvidence: [
        {
          fulfillment_order_id: "ful-exception",
          provider_status: "CANCELLED",
          local_status: "exception",
          evidence_kind: "reconciliation",
        },
        {
          fulfillment_order_id: "ful-legacy",
          provider_status: "CANCELLED",
          local_status: "cancelled",
          evidence_kind: "reconciliation",
        },
        {
          fulfillment_order_id: "ful-unknown",
          provider_status: "CANCELLED",
          local_status: null,
          evidence_kind: "reconciliation",
        },
      ],
      inboundEvents: [],
      outboxEvents: [],
      communicationDeliveries: [],
      recoveryTokens: [],
    });

    expect(snapshot.orders.find((order) => order.orderId === "order-exception")).toMatchObject({
      customerStep: "exception",
      customerLabel: "Wymaga sprawdzenia",
    });
    expect(snapshot.orders.find((order) => order.orderId === "order-unknown")).toMatchObject({
      customerStep: "exception",
      customerLabel: "Wymaga sprawdzenia",
    });
    expect(snapshot.orders.find((order) => order.orderId === "order-legacy")).toMatchObject({
      customerStep: "exception",
      customerLabel: "Wymaga sprawdzenia",
    });
  });

  it("projects only a uniquely newer timed exception after delivered", () => {
    const snapshot = buildCustomerJourneySnapshotFromRows({
      lookup: { email: "x@example.com", pageSize: 10 },
      client: { id: "client-1", email: "x@example.com" },
      orders: [
        { id: "order-returned", client_id: "client-1", status: "fulfilled" },
        { id: "order-stale", client_id: "client-1", status: "fulfilled" },
        { id: "order-unknown", client_id: "client-1", status: "fulfilled" },
      ],
      subscriptions: [],
      cycles: [],
      paymentIntents: [],
      paymentAttempts: [],
      paymentTransitions: [],
      fulfillmentOrders: [
        { id: "ful-returned", order_id: "order-returned", status: "delivered", delivered_at: "2026-07-16T10:00:00.000Z" },
        { id: "ful-stale", order_id: "order-stale", status: "delivered", delivered_at: "2026-07-16T10:00:00.000Z" },
        { id: "ful-unknown", order_id: "order-unknown", status: "delivered" },
      ],
      shipmentRefs: [],
      statusEvidence: [
        evidence("ful-returned", "exception", "RETURNED_TO_SENDER", "2026-07-16T12:00:00.000Z"),
        evidence("ful-stale", "exception", "RETURNED_TO_SENDER", "2026-07-16T09:00:00.000Z"),
        evidence("ful-unknown", "delivered", "DELIVERED", "2026-07-16T10:00:00.000Z"),
        evidence("ful-unknown", "exception", "RETURNED_TO_SENDER", null),
      ],
      inboundEvents: [],
      outboxEvents: [],
      communicationDeliveries: [],
      recoveryTokens: [],
    });

    expect(snapshot.orders.find((order) => order.orderId === "order-returned")?.customerStep).toBe("exception");
    expect(snapshot.orders.find((order) => order.orderId === "order-stale")?.customerStep).toBe("delivered");
    expect(snapshot.orders.find((order) => order.orderId === "order-unknown")?.customerStep).toBe("delivered");
    expect(snapshot.orders.find((order) => order.orderId === "order-unknown")?.fulfillment.trackingTimeline)
      .toContainEqual(expect.objectContaining({ eventType: "RETURNED_TO_SENDER", occurredAt: null }));
  });

  it("retains the authoritative fulfillment evidence id and local outcome for portable projection", () => {
    const snapshot = buildCustomerJourneySnapshotFromRows({
      lookup: { orderId: "order-1", pageSize: 10 }, client: { id: "client-1", email: "x@example.com" }, orders: [{ id: "order-1", client_id: "client-1", status: "paid" }], subscriptions: [], cycles: [], paymentIntents: [], paymentAttempts: [], paymentTransitions: [],
      fulfillmentOrders: [{ id: "ful-1", order_id: "order-1", status: "in_transit" }], shipmentRefs: [], inboundEvents: [], outboxEvents: [], communicationDeliveries: [], recoveryTokens: [],
      statusEvidence: [{ id: "evidence-1", fulfillment_order_id: "ful-1", local_status: "in_transit", provider_status: "SHIPPING", evidence_kind: "webhook", occurred_at: "2026-01-01T00:00:00.000Z" }],
    });
    expect(snapshot.timeline[0]).toMatchObject({ entityRef: { observationId: "evidence-1", outcome: "in_transit" } });
  });
});

describe("fulfilment resolution when an order holds a replacement parcel", () => {
  // The rule: the parcel that currently represents the order is the highest
  // `sequence_no`, tie-broken by `id`. With one row that is the row itself, which is why
  // the support snapshot is unchanged for every order that exists today.
  it("shows the only parcel when the order holds one fulfilment row", () => {
    const snapshot = snapshotForFulfillments([
      { id: "ful-0", order_id: "order-1", sequence_no: 0, status: "shipped" },
    ]);

    expect(snapshot.orders[0].fulfillment).toMatchObject({ fulfillmentOrderId: "ful-0", status: "shipped" });
    expect(snapshot.orders[0].customerAccountProjection.fulfillmentStatus).toBe("shipped");
    expect(snapshot.orders[0].omsProjection.fulfillmentStatus).toBe("shipped");
  });

  it.each([
    { name: "replacement read last", order: ["original", "replacement"] },
    { name: "replacement read first", order: ["replacement", "original"] },
  ])("shows the replacement parcel, not whichever row arrived first ($name)", ({ order }) => {
    const rows: Record<string, Record<string, unknown>> = {
      original: { id: "ful-0", order_id: "order-1", sequence_no: 0, status: "exception" },
      replacement: { id: "ful-1", order_id: "order-1", sequence_no: 1, status: "shipped" },
    };
    const snapshot = snapshotForFulfillments(order.map((key) => rows[key]));

    expect(snapshot.orders[0].fulfillment).toMatchObject({ fulfillmentOrderId: "ful-1", status: "shipped" });
    expect(snapshot.orders[0].customerAccountProjection.fulfillmentStatus).toBe("shipped");
  });

  it("breaks a same-sequence tie by id rather than by read order", () => {
    const snapshot = snapshotForFulfillments([
      { id: "ful-b", order_id: "order-1", sequence_no: 0, status: "shipped" },
      { id: "ful-a", order_id: "order-1", sequence_no: 0, status: "packed" },
    ]);

    expect(snapshot.orders[0].fulfillment).toMatchObject({ fulfillmentOrderId: "ful-b", status: "shipped" });
  });

  it("keeps order communication history but requires current-parcel proof for shipment confirmation", () => {
    const snapshot = snapshotForFulfillments(
      [{ id: "ful-1", order_id: "order-1", sequence_no: 0, status: "in_transit" }],
      [
        { aggregate_id: "order-1", fulfillment_order_id: "ful-0", purpose: "shipment_dispatched", status: "delivered" },
        { aggregate_id: "another-order", fulfillment_order_id: "ful-1", purpose: "shipment_dispatched", status: "delivered" },
      ],
    );

    expect(snapshot.orders[0].communications).toEqual([expect.objectContaining({ purpose: "shipment_dispatched", status: "delivered" })]);
    expect(snapshot.orders[0].gaps).toContainEqual(expect.objectContaining({ code: "shipment_email_identity_unconfirmed" }));
    expect(snapshot.orders[0].gaps).not.toContainEqual(expect.objectContaining({ code: "shipment_email_not_confirmed" }));
  });

  it("uses a canonical shipment delivery bound to the current parcel to satisfy the obligation", () => {
    const snapshot = snapshotForFulfillments(
      [{ id: "ful-1", order_id: "order-1", sequence_no: 0, status: "in_transit" }],
      [{ aggregate_id: "order-1", fulfillment_order_id: "ful-1", purpose: "shipment_dispatched", status: "delivered" }],
    );

    expect(snapshot.orders[0].communications).toEqual([expect.objectContaining({ purpose: "shipment_dispatched", status: "delivered" })]);
    expect(snapshot.orders[0].gaps).not.toContainEqual(expect.objectContaining({ code: "shipment_email_identity_unconfirmed" }));
    expect(snapshot.orders[0].gaps).not.toContainEqual(expect.objectContaining({ code: "shipment_email_not_confirmed" }));
  });
});

function snapshotForFulfillments(fulfillmentOrders: Record<string, unknown>[], communicationDeliveries: Record<string, unknown>[] = []) {
  return buildCustomerJourneySnapshotFromRows({
    lookup: { orderId: "order-1", pageSize: 10 },
    client: { id: "client-1", email: "x@example.com" },
    orders: [{ id: "order-1", client_id: "client-1", status: "paid" }],
    subscriptions: [],
    cycles: [],
    paymentIntents: [],
    paymentAttempts: [],
    paymentTransitions: [],
    fulfillmentOrders,
    shipmentRefs: [],
    statusEvidence: [],
    inboundEvents: [],
    outboxEvents: [],
    communicationDeliveries,
    recoveryTokens: [],
  });
}

function evidence(fulfillmentOrderId: string, localStatus: string, providerStatus: string, occurredAt: string | null) {
  return {
    fulfillment_order_id: fulfillmentOrderId,
    local_status: localStatus,
    provider_status: providerStatus,
    evidence_kind: "reconciliation",
    occurred_at: occurredAt,
    created_at: "2026-07-16T13:00:00.000Z",
  };
}

import { describe, expect, it } from "vitest";
import { buildTimeline, mapOrderSnapshot, nextChecks, orderGaps, subscriptionGaps, timelineWindowWarning } from "./customerJourneyProjection.js";

describe("customer journey projection helpers", () => {
  it("builds ordered operational timeline and next checks", () => {
    const timeline = buildTimeline({
      customer: { id: "client-1", created_at: "2026-01-01T00:00:00.000Z" },
      checkout: { orderDrafts: [], recoveryTokens: [], abandonedCartEvents: [] },
      orders: [],
      subscriptions: [],
    });

    expect(timeline[0]).toMatchObject({ kind: "customer.created", source: "clients" });
    expect(subscriptionGaps({ id: "sub-1", status: "active" }, [], null)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "subscription_payment_method_missing" })]),
    );
    expect(nextChecks({ gaps: [], hasOrders: false, hasCustomer: false, subscriptions: [] })).toEqual(
      expect.arrayContaining([expect.stringContaining("customer_journey_search")]),
    );
  });

  it("keeps the newest eighty entries with deterministic ties and excludes scheduled/current observations", () => {
    const orders = Array.from({ length: 82 }, (_, index) => ({
      orderId: `order-${index}`, orderNumber: null, mode: null, status: "paid", customerStep: "paid", customerLabel: "Paid", customerAccountProjection: {}, omsProjection: {}, fulfillment: { fulfillmentOrderId: null, trackingTimeline: [] }, providerEvidence: [], gaps: [],
      communications: [{ id: `delivery-${index}`, purpose: "shipment_dispatched", templateSlug: null, triggerSource: null, status: index === 81 ? "failed" : "delivered", providerKind: null, providerMessageId: null, queuedAt: null, sentAt: null, deliveredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), terminalAt: null, outboxEventId: null, emailSendId: null }],
    })) as Parameters<typeof buildTimeline>[0]["orders"];
    const input = { customer: null, checkout: { orderDrafts: [], recoveryTokens: [], abandonedCartEvents: [] }, orders, subscriptions: [{ subscriptionId: "sub", nextCycleAt: "2099-01-01T00:00:00.000Z", cycles: [{ cycleId: "future", status: "planned", scheduledAt: "2099-01-01T00:00:00.000Z", paidAt: null }], renewalOrders: [], renewalCommunications: [], gaps: [] }] as never };
    const first = buildTimeline(input), shifted = buildTimeline({ ...input, orders: [{ ...orders[0], communications: [{ ...orders[0].communications[0], id: "earlier", deliveredAt: "2025-01-01T00:00:00.000Z" }] }, ...orders] });

    expect(first).toHaveLength(80);
    expect(first[0]).toMatchObject({ kind: "communication.email", entityRef: { communicationId: "delivery-2", outcome: "delivered" } });
    expect(first.at(-1)).toMatchObject({ kind: "communication.email", entityRef: { communicationId: "delivery-81", outcome: "failed" } });
    expect(first.some((event) => event.kind === "subscription.next_cycle")).toBe(false);
    expect(timelineWindowWarning(input)).toBe("evidence_window_limited:customer_journey_timeline");
    expect(first.map((event) => event.entityRef.communicationId)).toEqual(shifted.slice(0, 80).map((event) => event.entityRef.communicationId));
    const ties = buildTimeline({ ...input, orders: orders.slice(0, 2).map((order) => ({ ...order, communications: [{ ...order.communications[0], deliveredAt: "2026-02-01T00:00:00.000Z" }] })) });
    expect(ties.map((event) => event.entityRef.communicationId)).toEqual(["delivery-0", "delivery-1"]);
  });

  it("does not let a payment email discharge a shipment communication gap", () => {
    const gaps = orderGaps({ fulfillment: { status: "in_transit", providerTrackingId: "tracking" } } as never, [{ id: "payment", purpose: "payment_confirmation", templateSlug: null, triggerSource: null, status: "delivered", providerKind: null, providerMessageId: null, queuedAt: null, sentAt: null, deliveredAt: null, terminalAt: null, outboxEventId: null, emailSendId: null }], []);
    expect(gaps).toContainEqual(expect.objectContaining({ code: "shipment_email_not_confirmed" }));
  });


  it.each([{ communicationDeliveries: [] }, { communicationDeliveries: [{ id: "old-mail", purpose: "shipment_dispatched", status: "delivered" }] }])(
    "keeps primary-path parcel communication identity unknown with order-level evidence %j",
    ({ communicationDeliveries }) => {
      const snapshot = mapOrderSnapshot({
        ...orderFixture({ fulfillmentStatus: "in_transit", evidenceStatus: null, providerStatus: null }),
        communicationDeliveries,
      } as never);
      expect(snapshot.gaps).toContainEqual(expect.objectContaining({ code: "shipment_email_identity_unconfirmed" }));
      expect(snapshot.gaps).not.toContainEqual(expect.objectContaining({ code: "shipment_email_not_confirmed" }));
    },
  );

  it("classifies current, legacy and provider-only CANCELLED evidence as exception", () => {
    const localException = mapOrderSnapshot(orderFixture({
      evidenceStatus: "exception",
      providerStatus: "CANCELLED",
    }) as never);
    const legacyCancelled = mapOrderSnapshot(orderFixture({
      evidenceStatus: "cancelled",
      providerStatus: "CANCELLED",
    }) as never);
    const providerOnly = mapOrderSnapshot(orderFixture({
      evidenceStatus: null,
      providerStatus: "CANCELLED",
    }) as never);

    expect(localException).toMatchObject({
      customerStep: "exception",
      customerLabel: "Wymaga sprawdzenia",
    });
    expect(legacyCancelled).toMatchObject({
      customerStep: "exception",
      customerLabel: "Wymaga sprawdzenia",
    });
    expect(providerOnly).toMatchObject({
      customerStep: "exception",
      customerLabel: "Wymaga sprawdzenia",
    });
  });

  it("uses provider occurrence time, not evidence array order, after delivery", () => {
    const returned = mapOrderSnapshot(orderFixture({
      evidenceStatus: null,
      providerStatus: null,
      fulfillmentStatus: "delivered",
      evidence: [
        statusEvidence("exception", "RETURNED_TO_SENDER", "2026-07-16T12:00:00.000Z", "2026-07-16T12:01:00.000Z"),
        statusEvidence("delivered", "DELIVERED", "2026-07-16T10:00:00.000Z", "2026-07-16T13:00:00.000Z"),
      ],
    }) as never);
    const staleReturn = mapOrderSnapshot(orderFixture({
      evidenceStatus: null,
      providerStatus: null,
      fulfillmentStatus: "delivered",
      evidence: [
        statusEvidence("exception", "RETURNED_TO_SENDER", "2026-07-16T09:00:00.000Z", "2026-07-16T13:00:00.000Z"),
        statusEvidence("delivered", "DELIVERED", "2026-07-16T10:00:00.000Z", "2026-07-16T10:01:00.000Z"),
      ],
    }) as never);
    const unknownTimeReturn = mapOrderSnapshot(orderFixture({
      evidenceStatus: null,
      providerStatus: null,
      fulfillmentStatus: "delivered",
      evidence: [
        statusEvidence("exception", "RETURNED_TO_SENDER", null, "2026-07-16T13:00:00.000Z"),
        statusEvidence("delivered", "DELIVERED", "2026-07-16T10:00:00.000Z", "2026-07-16T10:01:00.000Z"),
      ],
    }) as never);

    expect(returned).toMatchObject({ customerStep: "exception", customerLabel: "Wymaga sprawdzenia" });
    expect(staleReturn).toMatchObject({ customerStep: "delivered", customerLabel: "Dostarczono" });
    expect(unknownTimeReturn).toMatchObject({ customerStep: "delivered", customerLabel: "Dostarczono" });
  });

  it("deduplicates the same timed return from webhook and reconciliation", () => {
    const returned = mapOrderSnapshot(orderFixture({
      evidenceStatus: null,
      providerStatus: null,
      fulfillmentStatus: "delivered",
      evidence: [
        statusEvidence("delivered", "DELIVERED", "2026-07-16T10:00:00.000Z", "2026-07-16T10:01:00.000Z"),
        statusEvidence("exception", "RETURNED_TO_SENDER", "2026-07-16T12:00:00.000Z", "2026-07-16T12:01:00.000Z", "webhook"),
        statusEvidence("exception", "RETURNED_TO_SENDER", "2026-07-16T12:00:00.000Z", "2026-07-16T12:02:00.000Z", "reconciliation"),
      ],
    }) as never);

    expect(returned).toMatchObject({ customerStep: "exception", customerLabel: "Wymaga sprawdzenia" });
  });

  it("uses an existing delivered operation when provider delivery time is missing", () => {
    const returned = mapOrderSnapshot(orderFixture({
      evidenceStatus: null,
      providerStatus: null,
      fulfillmentStatus: "delivered",
      evidence: [
        statusEvidence("delivered", "DELIVERED", null, "2026-07-16T10:01:00.000Z"),
        statusEvidence("exception", "RETURNED_TO_SENDER", "2026-07-16T12:00:00.000Z", "2026-07-16T12:01:00.000Z"),
      ],
      trackingTimeline: [{
        eventType: "delivery_delivered",
        label: "Dostarczono",
        occurredAt: "2026-07-16T10:00:00.000Z",
        source: "fulfillment",
      }],
    }) as never);

    expect(returned).toMatchObject({ customerStep: "exception", customerLabel: "Wymaga sprawdzenia" });
  });
});

function orderFixture(input: {
  evidenceStatus: string | null;
  providerStatus: string | null;
  fulfillmentStatus?: string;
  evidence?: ReturnType<typeof statusEvidence>[];
  trackingTimeline?: Array<{
    eventType: string;
    label: string;
    occurredAt: string | null;
    source: string;
  }>;
}) {
  return {
    orderId: "order-1",
    orderNumber: "OPENLUP-TEST",
    mode: "one_time",
    status: "paid",
    updatedAt: "2026-07-16T08:00:00.000Z",
    attentionReason: null,
    nextAction: null,
    fulfillmentEligibility: null,
    accounting: null,
    activeHoldCount: input.evidenceStatus === "exception" ? 1 : 0,
    subscription: null,
    payment: { status: "succeeded" },
    fulfillment: {
      fulfillmentOrderId: "fulfillment-1",
      status: input.fulfillmentStatus ?? "created",
      providerKind: "omnipack",
      providerTrackingId: null,
      trackingUrl: null,
      carrierKind: null,
      latestOperationType: null,
      latestOperationAt: null,
      trackingReferences: [],
      trackingTimeline: input.trackingTimeline ?? [],
      providerEvidence: input.evidence ?? [statusEvidence(
        input.evidenceStatus,
        input.providerStatus,
        "2026-07-16T08:00:00.000Z",
        "2026-07-16T08:00:00.000Z",
      )],
    },
    communicationDeliveries: [],
  };
}

function statusEvidence(
  status: string | null,
  providerStatus: string | null,
  occurredAt: string | null,
  updatedAt: string,
  evidenceKind = "reconciliation",
) {
  return {
    evidenceType: "status_evidence" as const,
    status,
    providerStatus,
    providerOrderId: null,
    evidenceKind,
    occurredAt,
    updatedAt,
    summary: null,
  };
}

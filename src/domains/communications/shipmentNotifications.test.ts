import { describe, expect, it } from "vitest";
import {
  planShipmentNotification,
  shipmentNotificationEventSchema,
  shipmentNotificationPlanSchema,
  type ShipmentNotificationEvent,
} from "./shipmentNotifications.js";

const event: ShipmentNotificationEvent = {
  orderId: "88888888-8888-8888-8888-888888888888",
  clientId: "11111111-1111-1111-1111-111111111111",
  status: "shipped",
  trackingNumbers: ["TRACK-1"],
  trackingUrl: null,
  occurredAt: "2026-06-10T12:00:00+00:00",
};

describe("shipment notifications", () => {
  it("plans shipment emails through communications-owned template slugs", () => {
    const parsed = shipmentNotificationEventSchema.parse(event);
    const plan = shipmentNotificationPlanSchema.parse(planShipmentNotification(parsed));

    expect(plan).toMatchObject({
      templateSlug: "commerce-shipment-dispatched",
      source: "shipment-status",
      shouldNotifyCustomer: true,
    });
    expect(plan.idempotencyKey).toContain(event.orderId);
    expect(plan.idempotencyKey).toContain("TRACK-1");
  });

  it("uses quiet exception and delivered templates without a new mailer contract", () => {
    expect(planShipmentNotification({ ...event, status: "delivered" }).templateSlug).toBe("commerce-shipment-delivered");
    expect(planShipmentNotification({ ...event, status: "exception" }).templateSlug).toBe("commerce-shipment-exception");
  });

  it("avoids noisy shipped emails without tracking evidence", () => {
    expect(planShipmentNotification({ ...event, trackingNumbers: [] }).shouldNotifyCustomer).toBe(false);
    expect(planShipmentNotification({ ...event, status: "dispatched", trackingNumbers: [] }).shouldNotifyCustomer).toBe(true);
  });

  it("uses provider-neutral tracking refs for idempotency and notification gating", () => {
    const plan = planShipmentNotification({
      ...event,
      trackingNumbers: [],
      trackingReferences: [{
        providerKind: "omnipack",
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
        trackingNumber: "INPOST-1",
        trackingUrl: "https://inpost.example/track/INPOST-1",
      }],
    });

    expect(plan.shouldNotifyCustomer).toBe(true);
    expect(plan.idempotencyKey).toContain("INPOST-1");
    expect(plan.idempotencyKey).not.toContain("TRACK-1");
  });
});

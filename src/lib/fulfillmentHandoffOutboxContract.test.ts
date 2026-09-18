import { describe, expect, it } from "vitest";
import {
  COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE,
  commerceFulfillmentHandedOverPayloadSchema,
} from "./fulfillmentHandoffOutboxContract.js";

describe("fulfillment handoff outbox contract", () => {
  it("pins the durable event type", () => {
    expect(COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE).toBe(
      "commerce.fulfillment.handed_over",
    );
  });

  it("accepts the minimal handoff identity payload", () => {
    expect(
      commerceFulfillmentHandedOverPayloadSchema.parse({
        fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
        orderUuid: "22222222-2222-4222-8222-222222222222",
        occurredAt: "2026-07-16T10:30:00.000Z",
      }),
    ).toEqual({
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      orderUuid: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-16T10:30:00.000Z",
    });
  });

  it("normalizes the public shipment-rail identity to the canonical handoff identity", () => {
    expect(commerceFulfillmentHandedOverPayloadSchema.parse({
      shipmentUuid: "11111111-1111-4111-8111-111111111111",
      orderUuid: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-16T10:30:00.000Z",
    })).toEqual({
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      orderUuid: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-16T10:30:00.000Z",
    });
  });

  it("rejects malformed or expanded payloads", () => {
    expect(() => commerceFulfillmentHandedOverPayloadSchema.parse({
      fulfillmentOrderId: "not-a-guid",
      orderUuid: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-16",
      customerEmail: "must-not-enter-shared-outbox@example.invalid",
    })).toThrow();
  });
});

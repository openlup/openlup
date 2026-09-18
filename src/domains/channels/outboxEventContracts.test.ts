import { describe, expect, it } from "vitest";
import {
  CHANNEL_ORDER_INGESTED_EVENT_CONTRACT_VERSION,
  CHANNEL_SHIPMENT_PUSH_REQUESTED_EVENT_CONTRACT_VERSION,
  channelOrderIngestedPayloadSchema,
  channelShipmentPushRequestedPayloadSchema,
} from "./outboxEventContracts.js";

describe("channel outbox event payloads", () => {
  it("accepts a well-formed channel.order.ingested payload", () => {
    expect(
      channelOrderIngestedPayloadSchema.safeParse({
        contract_version: CHANNEL_ORDER_INGESTED_EVENT_CONTRACT_VERSION,
        order_id: "3f2f7f6a-2f6e-4f0e-9b8a-1c2d3e4f5a6b",
        channel_slug: "example-marketplace",
        external_order_ref: "EXT-1001",
        ingested_at: "2026-08-11T10:06:00+02:00",
      }).success,
    ).toBe(true);
  });

  it("rejects an ingested payload with a wrong contract version", () => {
    expect(
      channelOrderIngestedPayloadSchema.safeParse({
        contract_version: "channel.order.ingested.v0",
        order_id: "3f2f7f6a-2f6e-4f0e-9b8a-1c2d3e4f5a6b",
        channel_slug: "example-marketplace",
        external_order_ref: "EXT-1001",
        ingested_at: "2026-08-11T10:06:00+02:00",
      }).success,
    ).toBe(false);
  });

  it("accepts a shipment push-requested payload with nullable tracking", () => {
    expect(
      channelShipmentPushRequestedPayloadSchema.safeParse({
        contract_version: CHANNEL_SHIPMENT_PUSH_REQUESTED_EVENT_CONTRACT_VERSION,
        order_id: "3f2f7f6a-2f6e-4f0e-9b8a-1c2d3e4f5a6b",
        channel_slug: "example-marketplace",
        external_order_ref: "EXT-1001",
        carrier_kind: "carrier-x",
        tracking_ref: null,
        tracking_url: null,
        shipped_at: "2026-08-12T09:00:00+02:00",
      }).success,
    ).toBe(true);
  });
});

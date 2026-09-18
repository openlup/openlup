import { z } from "../../lib/validation/zod.js";
import { channelSlugSchema, externalRefSchema } from "./contracts.js";

// Reserved outbox event vocabulary for the channels domain. Constants and
// payload schemas are authored here so later waves emit and consume one
// shape; NOTHING emits either event in this wave.
//
// channel.order.ingested — emitted by the ingest RPC (wave B4) in the same
// transaction that creates a channel order. Deliberately ships with no
// registered outbox handler at first: the dispatcher's claim anti-join leaves
// unregistered event types pending harmlessly, and the event becomes the hook
// for OMS/analytics consumers later.
//
// channel.shipment.push_requested — the outbound tracking push-back seam.
// Emission is deferred to the wave that ships its handler (emitting into a
// handler-less allowlist would only pile up rows); when live, it fires off the
// canonical Layer B `in_transit` fulfillment boundary for channel-sourced
// orders only (B5: partner-confirmed signal, never an optimistic timer).

const timestampSchema = z.string().datetime({ offset: true });

export const CHANNEL_ORDER_INGESTED_EVENT_TYPE = "channel.order.ingested";
export const CHANNEL_ORDER_INGESTED_EVENT_CONTRACT_VERSION =
  "channel.order.ingested.v1";

export const channelOrderIngestedPayloadSchema = z
  .object({
    contract_version: z.literal(CHANNEL_ORDER_INGESTED_EVENT_CONTRACT_VERSION),
    order_id: z.guid(),
    channel_slug: channelSlugSchema,
    external_order_ref: externalRefSchema,
    ingested_at: timestampSchema,
  })
  .strict();

export type ChannelOrderIngestedPayload = z.infer<
  typeof channelOrderIngestedPayloadSchema
>;

export const CHANNEL_SHIPMENT_PUSH_REQUESTED_EVENT_TYPE =
  "channel.shipment.push_requested";
export const CHANNEL_SHIPMENT_PUSH_REQUESTED_EVENT_CONTRACT_VERSION =
  "channel.shipment.push_requested.v1";

export const channelShipmentPushRequestedPayloadSchema = z
  .object({
    contract_version: z.literal(
      CHANNEL_SHIPMENT_PUSH_REQUESTED_EVENT_CONTRACT_VERSION,
    ),
    order_id: z.guid(),
    channel_slug: channelSlugSchema,
    external_order_ref: externalRefSchema,
    carrier_kind: z.string().trim().min(1).max(64),
    tracking_ref: z.string().trim().max(120).nullable(),
    tracking_url: z.string().trim().max(500).nullable(),
    shipped_at: timestampSchema,
  })
  .strict();

export type ChannelShipmentPushRequestedPayload = z.infer<
  typeof channelShipmentPushRequestedPayloadSchema
>;

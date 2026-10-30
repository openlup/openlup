
export type { ChannelOrderIngestedPayload } from "./contracts/index.js";
import { z } from "zod";
import { channelSlugSchema, externalRefSchema } from "./contracts.js";
// Vocabulary only: no event producer, dispatcher or ACK is installed here.
export const CHANNEL_PURCHASE_SOURCE_EVENT_TYPE = "channel.purchase-source.v1";
export const CHANNEL_PURCHASE_LINE_EVENT_TYPE = "channel.purchase-line.v1";
export const CHANNEL_PULL_PAGE_EVENT_TYPE = "channel.pull-page.v1";
export const CHANNEL_ORDER_INGESTED_EVENT_TYPE = "channel.order.ingested";
export const CHANNEL_ORDER_INGESTED_EVENT_CONTRACT_VERSION = "channel.order.ingested.v1";
export const channelOrderIngestedPayloadSchema = z.object({
  contract_version: z.literal(CHANNEL_ORDER_INGESTED_EVENT_CONTRACT_VERSION), order_id: z.guid(),
  channel_slug: channelSlugSchema, external_order_ref: externalRefSchema, ingested_at: z.string().datetime({ offset: true }),
}).strict();

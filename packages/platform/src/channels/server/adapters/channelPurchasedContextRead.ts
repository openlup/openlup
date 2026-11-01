import { z } from "../../validation.js";
import { channelControlIdSchema as id, channelScopeSchema } from "../../channelRegistryContracts.js";
import { channelPurchaseCaptureSchema, type ChannelPurchaseCapture } from "../../channelPurchaseSourceContracts.js";
import { channelBundleBindingSchema, channelListingDetailSchema, type ChannelBundleBinding } from "../../channelListingContracts.js";
import type { ChannelRetainedPurchaseContext } from "../channelPurchaseResolver.js";
import { ChannelControlError } from "../channelPurchasedIngestStep.js";
import type { ChannelRailsRpc } from "../channelIngestRails.js";

export interface PurchasedReadQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): PurchasedReadQuery; eq(key: string, value: unknown): PurchasedReadQuery;
  in(key: string, values: readonly unknown[]): PurchasedReadQuery; not(key: string, operator: string, value: unknown): PurchasedReadQuery;
  order(key: string, options?: { ascending: boolean }): PurchasedReadQuery; limit(count: number): PurchasedReadQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface PurchasedReadClient extends ChannelRailsRpc { from(table: string): PurchasedReadQuery }
export interface ChannelHistoricalBundleReadPort { read(bundleId: string): Promise<ChannelBundleBinding | null> }
const rows = (value: unknown) => z.array(z.record(z.string(), z.unknown())).parse(value);
/** Historical context only: catalogue qualification, approval and exposure authoring are absent. */
export function createManagedChannelPurchasedContextRead(input: {
  client: PurchasedReadClient; actorId: string; bundles: ChannelHistoricalBundleReadPort;
}) {
  const actorId = id.parse(input.actorId);
  async function read(query: PromiseLike<{ data: unknown; error: unknown }>) {
    const result = await query;
    if (result.error) throw new ChannelControlError("store_unavailable");
    return result.data;
  }
  return {
    async contexts(capture: ChannelPurchaseCapture): Promise<ChannelRetainedPurchaseContext[]> {
      const connection = z.object({ application_ref: z.string().min(1) }).parse(await read(input.client.from("sales_channel_connections")
        .select("application_ref").eq("id", capture.scope.connectionId).maybeSingle()));
      const channel = z.object({ connection_id: id, channel_external_ref: z.string().nullable(), slug: z.string() }).parse(await read(input.client.from("sales_channels")
        .select("connection_id,channel_external_ref,slug").eq("id", capture.scope.channelId).maybeSingle()));
      if (channel.connection_id !== capture.scope.connectionId) throw new ChannelControlError("input_conflict");
      const namespace = { applicationRef: connection.application_ref, channelExternalRef: channel.channel_external_ref };
      const result: ChannelRetainedPurchaseContext[] = [];
      for (const fact of capture.products) {
        if (result.some(context => context.listing.externalOfferRef === fact.externalOfferRef)) continue;
        const found = rows(await read(input.client.from("sales_channel_listings").select("id").eq("channel_id", capture.scope.channelId)
          .eq("external_offer_ref", fact.externalOfferRef).limit(2)));
        if (found.length !== 1) throw new ChannelControlError("input_conflict");
        const detail = channelListingDetailSchema.parse(await read(input.client.rpc("channel_listing_read", {
          p_listing_id: id.parse(found[0].id), p_actor_id: actorId,
        })));
        if (!detail.firstApproval || !detail.firstQualification) throw new ChannelControlError("input_conflict");
        const value = await input.bundles.read(detail.listing.bundleId);
        if (!value) throw new ChannelControlError("input_conflict");
        result.push({ scope: channelScopeSchema.parse(detail.listing.scope), namespace, channelSlug: channel.slug,
          listing: detail.listing, firstApproval: detail.firstApproval, firstQualification: detail.firstQualification,
          bundle: channelBundleBindingSchema.parse(value) });
      }
      return result;
    },
    async pageDigest(pagePacketId: string) {
      return z.object({ metadata: z.object({ inputDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).passthrough() }).strict()
        .parse(await read(input.client.from("outbox_events").select("metadata").eq("id", id.parse(pagePacketId))
          .eq("event_type", "channel.pull-page.v1").maybeSingle())).metadata.inputDigest;
    },
    async original(ledgerId: string) {
      const row = z.object({ purchase_capture_text: z.string() }).strict().parse(await read(input.client.from("channel_order_ingests")
        .select("purchase_capture_text").eq("id", id.parse(ledgerId)).maybeSingle()));
      return channelPurchaseCaptureSchema.parse(JSON.parse(row.purchase_capture_text));
    },
    async exposure(listingId: string) {
      return z.object({ exposure_generation: z.number().int().nonnegative(), exposure_issued_basis_ref: id }).strict()
        .parse(await read(input.client.from("sales_channel_listings").select("exposure_generation,exposure_issued_basis_ref")
          .eq("id", id.parse(listingId)).maybeSingle()));
    },
    async lineItems(orderId: string, externalLineRef: string) {
      return rows(await read(input.client.from("commerce_order_items").select("id,sku_id,quantity,product_snapshot").eq("order_id", id.parse(orderId))
        .order("allocation_ordinal", { ascending: true }))).filter(row => z.record(z.string(), z.unknown()).parse(row.product_snapshot).externalLineRef === externalLineRef)
        .map(row => ({ orderItemId: id.parse(row.id), skuId: id.parse(row.sku_id), quantity: z.number().int().positive().parse(row.quantity) }));
    },
    async reservations(orderId: string) {
      return z.array(z.object({ id, order_item_id: id, sku_id: id, quantity: z.number().int().positive(),
        status: z.literal("reserved"), expires_at: z.null(), idempotency_key: z.string(), metadata: z.record(z.string(), z.unknown()) }).passthrough())
        .parse(await read(input.client.from("inventory_reservations").select("id,order_item_id,sku_id,quantity,status,expires_at,idempotency_key,metadata")
          .eq("order_id", id.parse(orderId)).eq("status", "reserved")));
    },
    async pending(channelId: string) {
      return rows(await read(input.client.from("channel_order_ingests").select("purchase_capture_text").eq("channel_id", id.parse(channelId))
        .not("purchase_capture_text", "is", null).in("status", ["received", "buyer_ready", "order_created", "reserved", "settled", "blocked_stock", "failed"])
        .order("created_at", { ascending: true }).limit(50))).map(row => channelPurchaseCaptureSchema.parse(JSON.parse(String(row.purchase_capture_text))));
    },
  };
}

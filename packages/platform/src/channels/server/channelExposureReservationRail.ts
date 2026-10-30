import { canonicalChannelSource } from "./adapters/channelSourceStore.js";
import type { createChannelPurchasedSourceStore } from "./adapters/channelSourceStore.js";
import type { createManagedChannelPurchasedContextRead } from "./adapters/channelPurchasedContextRead.js";
import type { ChannelIngestReservationPort } from "../channelIngestStorePort.js";
import type { ChannelPurchaseCapture } from "../channelPurchaseSourceContracts.js";
import { ChannelControlError } from "./channelPurchasedIngestStep.js";

/** A sealed original command proves the atomic conversion committed, including after response loss. */
export function createChannelExposureReservationRail(input: {
  jobRunId: string; ledgerId: string; capture: ChannelPurchaseCapture;
  source: Pick<ReturnType<typeof createChannelPurchasedSourceStore>, "originalConversion">;
  read: Pick<ReturnType<typeof createManagedChannelPurchasedContextRead>, "exposure" | "lineItems" | "reservations">;
  newId(): string;
}): ChannelIngestReservationPort {
  return { async reserveChannelOrderItems(order) {
    const { capture, source } = input;
    if (!capture.retainedRows) throw new ChannelControlError("input_conflict");
    let reservedItemCount = 0;
    for (const line of capture.normalized.lines) {
      const pinned = capture.retainedRows.filter(row => row.externalLineRef === line.externalLineRef);
      if (!pinned.length || new Set(pinned.map(row => row.retained.listingId)).size !== 1) throw new ChannelControlError("input_conflict");
      const listingId = pinned[0].retained.listingId;
      const args = { ledgerId: input.ledgerId, externalLineRef: line.externalLineRef, jobRunId: input.jobRunId };
      let original = await source.originalConversion({ ...args, canonicalText: null });
      if (original === null) {
        const issued = await input.read.exposure(listingId);
        const command = { schemaVersion: "channel.exposure.v1", resourceKind: "listing", resourceId: listingId,
          operationId: input.newId(), operation: "exposure_convert_sale", expectedGeneration: issued.exposure_generation,
          payload: { scope: { connectionId: capture.scope.connectionId, channelId: capture.scope.channelId, connectorProviderKind: capture.scope.connectorKind,
            connectorShape: "direct", applicationRef: capture.namespace.applicationRef, environmentRef: capture.scope.environmentRef,
            sellerRef: capture.scope.sellerRef, channelExternalRef: capture.namespace.channelExternalRef, externalOfferRef: line.sellable.externalOfferRef },
          issuedBasisRef: issued.exposure_issued_basis_ref, ingestId: input.ledgerId, externalLineRef: line.externalLineRef,
          orderId: order.orderId, purchasedSets: line.quantity } };
        try { original = await source.originalConversion({ ...args, canonicalText: canonicalChannelSource(command) }); }
        catch (error) {
          original = await source.originalConversion({ ...args, canonicalText: null });
          if (original === null) throw error;
        }
      }
      if (original === null) throw new ChannelControlError("response_invalid");
      const command = JSON.parse(original) as { operation?: string; resourceId?: string; payload?: { ingestId?: string; orderId?: string; externalLineRef?: string; purchasedSets?: number } };
      if (canonicalChannelSource(command) !== original || command.operation !== "exposure_convert_sale" || command.resourceId !== listingId ||
        command.payload?.ingestId !== input.ledgerId || command.payload.orderId !== order.orderId || command.payload.externalLineRef !== line.externalLineRef ||
        command.payload.purchasedSets !== line.quantity) throw new ChannelControlError("response_invalid");
      const actual = await input.read.lineItems(order.orderId, line.externalLineRef);
      const holds = (await input.read.reservations(order.orderId)).filter(hold => actual.some(item => item.orderItemId === hold.order_item_id));
      if (!actual.length || holds.length !== actual.length || actual.some(item => !holds.some(hold => hold.order_item_id === item.orderItemId &&
        hold.sku_id === item.skuId && hold.quantity === item.quantity && hold.metadata.providerKind === order.providerKind &&
        hold.idempotency_key === `ch:${capture.scope.channelId}:ord:${capture.externalOrderRef}:inventory:${item.orderItemId}`)) ||
        actual.some(item => !order.items.some(known => known.orderItemId === item.orderItemId && known.skuId === item.skuId && known.quantity === item.quantity))) {
        throw new ChannelControlError("response_invalid");
      }
      reservedItemCount += holds.length;
    }
    if (reservedItemCount !== order.items.length) throw new ChannelControlError("response_invalid");
    return { reservedItemCount };
  } };
}

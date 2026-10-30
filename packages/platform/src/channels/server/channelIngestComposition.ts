import type { ChannelIngestChannelReadPort, ChannelIngestStorePort, ChannelIngestReservationPort, ChannelIngestOrderItemReadPort, ChannelIngestPaymentControlPort } from "../channelIngestStorePort.js";
import type { ChannelBundleReadPort } from "../bundleLineExpansion.js";
import { runChannelOrderIngest } from "./channelOrderIngestSaga.js";
import { ChannelIngestUnavailableError, type ChannelWebhookPort } from "./channelWebhookHandler.js";
export interface ChannelIngestRails {
  bundles?: ChannelBundleReadPort; reservations: ChannelIngestReservationPort;
  orderItems: ChannelIngestOrderItemReadPort; payments: ChannelIngestPaymentControlPort;
}
export interface ChannelIngestPortOptions {
  store: ChannelIngestStorePort; channels?: ChannelIngestChannelReadPort; rails?: ChannelIngestRails;
  acceptedCurrencies: readonly string[]; noopSettlementForbidden: boolean;
}
/** Host bindings are explicit; missing rails refuse before the first saga effect. */
export function createChannelWebhookPort(options: ChannelIngestPortOptions): ChannelWebhookPort {
  return {
    async ingestOrder(order) {
      if (!options.channels) throw new ChannelIngestUnavailableError("channel_read_unavailable");
      if (!options.rails) throw new ChannelIngestUnavailableError("channel_ingest_rails_unbound");
      return runChannelOrderIngest({ ...options.rails, store: options.store, channels: options.channels,
        acceptedCurrencies: options.acceptedCurrencies, noopSettlementForbidden: options.noopSettlementForbidden }, order);
    },
    async quarantineSignal({ providerEventId, signal }) {
      const record = await options.store.quarantine({ channelId: null, connectionId: null, providerEventId,
        externalOrderRef: signal.externalOrderRef, vocabulary: signal.vocabulary, reason: "unmapped_vocabulary",
        payload: { detail: signal.detail, payload: signal.payload } });
      return { quarantineId: record.id };
    },
  };
}

/** Host supplies the accepted capture and the conversion rail for this one immutable obligation. */
export async function ingestRetainedChannelPurchase(input: {
  capture: import("../channelPurchaseSourceContracts.js").ChannelPurchaseCapture;
  options: ChannelIngestPortOptions; reservations: ChannelIngestReservationPort;
}) {
  if (!input.options.channels) throw new ChannelIngestUnavailableError("channel_read_unavailable");
  if (!input.options.rails) throw new ChannelIngestUnavailableError("channel_ingest_rails_unbound");
  if (!input.capture.retainedRows) throw new ChannelIngestUnavailableError("channel_purchase_retained_rows_unavailable");
  return runChannelOrderIngest({ ...input.options.rails, store: input.options.store, channels: input.options.channels,
    reservations: input.reservations, purchasedRows: input.capture.retainedRows,
    acceptedCurrencies: input.options.acceptedCurrencies, noopSettlementForbidden: input.options.noopSettlementForbidden }, input.capture.normalized);
}

import type {
  ChannelConnectorPort,
  ChannelOrderSourcePort,
} from "../../../src/domains/channels/ports.js";
import type {
  ChannelIngestChannelReadPort,
  ChannelIngestOrderItemReadPort,
  ChannelIngestPaymentControlPort,
  ChannelIngestReservationPort,
  ChannelIngestStorePort,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import type { ChannelBundleReadPort } from "../../../src/domains/channels/bundleLineExpansion.js";
import type { UnmappedChannelSignal } from "../../../src/domains/channels/orderContracts.js";
import {
  createNoopChannelConnectorAdapter,
  NOOP_CHANNEL_CONNECTOR_KIND,
} from "../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import { getChannelConnector } from "../../domains/channels/channelConnectorRegistry.js";
import {
  ChannelIngestUnavailableError,
  type ChannelWebhookPort,
} from "../../domains/channels/channelWebhookHandler.js";
import { runChannelOrderIngest } from "../../domains/channels/channelOrderIngestSaga.js";

// What the two channel-ingest entrypoints are allowed to reach, and — just as importantly — what
// they are NOT.
//
// THE CONNECTOR MAP IS BUILT HERE AND NOWHERE ELSE. `getChannelConnector` is a switch over a map
// composition supplies (B4's house doctrine: the port is not a framework). This module is that
// composition. The simulator is placed in the map only where a simulated settlement may be
// believed, and the registry refuses it a second time on the way out, so the two checks would both
// have to be wrong for a rehearsal connector to reach a live shop.
//
// THE BORROWED RAILS WERE AN EXPLICIT, NAMED GAP, AND THEY ARE NOW BOUND. The saga drives five
// rails: the ledger store and the channel read, which the B4 binding resolves, plus reservations,
// order items and the payment control plane, which it did not. B5 declared those three as one
// optional slot and deliberately left it empty — an entrypoint wave is not the place to invent a
// money-moving adapter that no container run has ever executed — so an ORDER answered
// `channel_ingest_rails_unbound` and wrote nothing.
//
// The slot is filled now, by the two chain adapters, and the refusal it guards is STILL REACHABLE
// on purpose. It stays optional so that a composition which forgets the rails is refused by name
// before the saga starts rather than crashing between two of its steps, and so a deployment that
// binds only the ledger — the quarantine-only posture — keeps working end to end.

/** The three rails the saga borrows and the ledger store binding does not itself resolve. */
export interface ChannelIngestRails {
  /** Absent on a chain with no bundle catalogue; the saga then quarantines any bundle line. */
  bundles?: ChannelBundleReadPort;
  reservations: ChannelIngestReservationPort;
  orderItems: ChannelIngestOrderItemReadPort;
  payments: ChannelIngestPaymentControlPort;
}

export interface ChannelIngestPortOptions {
  store: ChannelIngestStorePort;
  channels?: ChannelIngestChannelReadPort;
  rails?: ChannelIngestRails;
  /**
   * Every currency this deployment will settle in. Threaded, not defaulted: composition is where
   * the platform's policy is READ, and a default here would let an entrypoint that never thought
   * about currency ingest an order in one nothing downstream can price.
   */
  acceptedCurrencies: readonly string[];
  /** True exactly where a simulated settlement must never be believed. */
  noopSettlementForbidden: boolean;
}

/**
 * The connector map for this deployment. `simulatorAllowed` is decided by the caller from the
 * environment, because environment marker reads belong outside the domain layer.
 */
export function resolveChannelConnectors(
  simulatorAllowed: boolean,
): Record<string, ChannelConnectorPort> {
  return simulatorAllowed
    ? { [NOOP_CHANNEL_CONNECTOR_KIND]: createNoopChannelConnectorAdapter() }
    : {};
}

/** Resolves one connector's order source, refusing a simulator wherever one must not run. */
export function resolveChannelOrderSource(
  connectorKind: string,
  simulatorAllowed: boolean,
): ChannelOrderSourcePort {
  return getChannelConnector(connectorKind, resolveChannelConnectors(simulatorAllowed), simulatorAllowed)
    .orders;
}

export function createChannelWebhookPort(options: ChannelIngestPortOptions): ChannelWebhookPort {
  return {
    async ingestOrder(order) {
      // Both missing halves are named separately. "The catalogue lane cannot answer with a
      // connector kind" and "no rail implementation is bound" are different operator problems, and
      // collapsing them into one reason would hide whichever one is actually true.
      if (!options.channels) throw new ChannelIngestUnavailableError("channel_read_unavailable");
      if (!options.rails) throw new ChannelIngestUnavailableError("channel_ingest_rails_unbound");
      return runChannelOrderIngest(
        {
          store: options.store,
          channels: options.channels,
          reservations: options.rails.reservations,
          orderItems: options.rails.orderItems,
          payments: options.rails.payments,
          bundles: options.rails.bundles,
          acceptedCurrencies: options.acceptedCurrencies,
          noopSettlementForbidden: options.noopSettlementForbidden,
        },
        order,
      );
    },

    async quarantineSignal(input) {
      const filed = await options.store.quarantine({
        // A delivery whose vocabulary we could not map is a delivery we cannot attribute to a
        // surface either: the signal carries a wire token, not a channel. Nulls here are the honest
        // answer, and the drawer stores them rather than guessing an owner.
        channelId: null,
        connectionId: null,
        providerEventId: input.providerEventId,
        externalOrderRef: input.signal.externalOrderRef,
        vocabulary: input.signal.vocabulary,
        reason: "unmapped_vocabulary",
        payload: quarantinePayload(input.signal),
      });
      return { quarantineId: filed.id };
    },
  };
}

function quarantinePayload(signal: UnmappedChannelSignal): Record<string, unknown> {
  return { detail: signal.detail, payload: signal.payload };
}

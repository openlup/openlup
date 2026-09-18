import type {
  NormalizedChannelOrder,
  UnmappedChannelSignal,
} from "./orderContracts.js";
import type { ConnectorShape } from "./contracts.js";

// The connector seam every sales-channel integration implements — one shape
// for BOTH a direct marketplace connector and an aggregator connector.
//
// Addressing model: `connectionRef` identifies the credential set / account
// (one row of sales_channel_connections); `channelExternalRef` addresses one
// sales surface behind it. A direct connector's connection IS the surface
// (channelExternalRef is null); an aggregator connection fans out to N
// surfaces and uses it. Same signatures, both shapes, by construction.
//
// House doctrine: this is a PORT, not a framework — no registry contract, no
// plugin loader, no manifest format. Those are forbidden until a second real
// connector implementation exists.

export interface ChannelConnectorCorrelationContract {
  /** Which wire field correlates to our external_order_ref (B4). */
  orderRefField: string;
  /** Which wire field carries a stable buyer identity; null = none exists. */
  customerRefField: string | null;
  customerRefNullMeans: "per_order_identity" | "unsupported";
  /** Declared fact about relay/alias buyer addresses on this platform. */
  emailIsAlwaysMasked: boolean;
}

export interface ChannelConnectorCapabilities {
  /** Open connector identity, e.g. "noop_channel"; never a closed brand union. */
  connectorKind: string;
  /** Structural shape, not a brand: direct = 1 surface, aggregator = N. */
  connectorShape: ConnectorShape;
  supportsChannelDiscovery: boolean;
  supportsOrderPull: boolean;
  supportsOrderWebhook: boolean;
  supportsOrderAck: boolean;
  supportsListingLink: boolean;
  supportsStockPush: boolean;
  supportsPricePush: boolean;
  supportsShipmentPush: boolean;
  correlation: ChannelConnectorCorrelationContract;
}

/** One addressable sales surface discovered behind a connection. */
export interface ChannelBinding {
  channelExternalRef: string;
  displayName: string;
  /** Free-form hint (e.g. which marketplace an aggregator surface maps to). */
  marketplaceHint: string | null;
  currency: string | null;
  regionCode: string | null;
}

export interface SellableRef {
  /** Open sellable kind; known values today: "sku", "bundle". */
  kind: string;
  code: string;
}

export type NormalizedWebhookResult =
  | { kind: "order"; providerEventId: string; order: NormalizedChannelOrder }
  | { kind: "unmapped"; providerEventId: string; signal: UnmappedChannelSignal }
  | { kind: "ignored"; providerEventId: string; reason: string }
  | { kind: "rejected"; reason: "signature" | "malformed" };

export interface ChannelOrderSourcePort {
  /** Enumerate surfaces behind a connection (aggregator fan-out discovery). */
  listChannelBindings(input: {
    connectionRef: string;
    signal: AbortSignal;
  }): Promise<ChannelBinding[]>;

  pullOrders(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    since: string | null;
    cursor: string | null;
    limit: number;
    signal: AbortSignal;
  }): Promise<{
    orders: readonly NormalizedChannelOrder[];
    /** Signals the connector could not normalize — surfaced, never dropped (B3). */
    unmapped: readonly UnmappedChannelSignal[];
    nextCursor: string | null;
    watermarkAt: string | null;
  }>;

  /**
   * Normalize one webhook delivery. Never throws on unknown vocabulary —
   * unknown wire tokens come back as `unmapped` (B3); signature failures come
   * back as `rejected` so the route can fail closed.
   */
  normalizeWebhook(input: {
    headers: Readonly<Record<string, string>>;
    rawBody: string;
    signal: AbortSignal;
  }): Promise<NormalizedWebhookResult>;

  acknowledgeOrder(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    externalOrderRef: string;
    localOrderRef: string;
    signal: AbortSignal;
  }): Promise<{ acknowledged: boolean; detail?: Record<string, unknown> }>;
}

export interface ChannelListingSyncPort {
  linkOffer(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    sellable: SellableRef;
    externalOfferRef: string;
    signal: AbortSignal;
  }): Promise<{ linked: boolean; resolvedOfferRef: string | null }>;

  pushOfferState(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    externalOfferRef: string;
    status: string;
    signal: AbortSignal;
  }): Promise<{ accepted: boolean }>;
}

export interface ChannelStockPricePushPort {
  pushStock(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    items: readonly { externalOfferRef: string; availableQty: number }[];
    signal: AbortSignal;
  }): Promise<{
    accepted: number;
    rejected: readonly { externalOfferRef: string; reason: string }[];
  }>;

  pushPrice(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    items: readonly {
      externalOfferRef: string;
      grossMinor: number;
      currency: string;
    }[];
    signal: AbortSignal;
  }): Promise<{
    accepted: number;
    rejected: readonly { externalOfferRef: string; reason: string }[];
  }>;
}

export interface ChannelShipmentSyncPort {
  pushShipment(input: {
    connectionRef: string;
    channelExternalRef: string | null;
    externalOrderRef: string;
    carrierKind: string;
    trackingRef: string | null;
    trackingUrl: string | null;
    shippedAt: string;
    signal: AbortSignal;
  }): Promise<{ accepted: boolean; externalShipmentRef: string | null }>;
}

/**
 * The full connector. Optional sub-ports MUST agree with the capability
 * descriptor (capability honesty is a frozen contract-fixture scenario):
 * `supportsStockPush === (stockPrice !== undefined)`, etc.
 */
export interface ChannelConnectorPort {
  readonly capabilities: ChannelConnectorCapabilities;
  readonly orders: ChannelOrderSourcePort;
  readonly listings?: ChannelListingSyncPort;
  readonly stockPrice?: ChannelStockPricePushPort;
  readonly shipments?: ChannelShipmentSyncPort;
}

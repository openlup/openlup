export type ConnectorShape = "direct" | "aggregator";
export type SalesChannelStatus = "disabled" | "testing" | "active" | "sunset";
export type BuyerCommsOwner = "platform" | "channel";
export type InvoicePolicy = "issue" | "suppress" | "channel_issues";
export interface NormalizedChannelOrderBuyer {
  externalCustomerRef: string | null; email: string | null; emailIsMasked: boolean;
  firstName: string | null; lastName: string | null; phone: string | null; taxId: string | null; companyName: string | null;
}
export interface NormalizedChannelOrderLine {
  externalLineRef: string;
  sellable: { kind: "sku"; externalOfferRef: string | null; skuCode: string | null } |
    { kind: "bundle"; externalOfferRef: string | null; bundleCode: string | null };
  quantity: number; unitGrossMinor: number; lineGrossMinor: number; lineDiscountMinor: number; vatRateBps: number | null;
}
export interface NormalizedChannelOrder {
  contractVersion: "channel.order.v1"; channelSlug: string; externalOrderRef: string; externalOrderRevision: string | null;
  providerEventId: string; placedAt: string; currency: string; buyer: NormalizedChannelOrderBuyer;
  shipTo: { recipientName: string; line1: string; line2: string | null; postalCode: string; city: string;
    countryCode: string; phone: string | null; pickupPointRef: string | null };
  lines: NormalizedChannelOrderLine[];
  shipping: { grossMinor: number; discountMinor: number; methodLabel: string | null; carrierHint: string | null };
  totals: { itemsGrossMinor: number; itemsDiscountMinor: number; shippingGrossMinor: number; shippingDiscountMinor: number; grandTotalMinor: number };
  payment: { state: string; externalPaymentRef: string; paidAt: string; methodLabel: string | null }; payloadDigest: string;
}
export interface UnmappedChannelSignal { vocabulary: string; externalOrderRef: string | null; detail: string | null; payload: Record<string, unknown> }
export type NormalizedWebhookResult = { kind: "order"; providerEventId: string; order: NormalizedChannelOrder } |
  { kind: "unmapped"; providerEventId: string; signal: UnmappedChannelSignal } |
  { kind: "ignored"; providerEventId: string; reason: string } | { kind: "rejected"; reason: "signature" | "malformed" };
export type ChannelIngestOrderedStatus = "received" | "buyer_ready" | "order_created" | "reserved" | "settled" | "done";
export type ChannelIngestHaltedStatus = "blocked_stock" | "quarantined" | "failed";
export type ChannelIngestStatus = ChannelIngestOrderedStatus | ChannelIngestHaltedStatus;
export type ChannelQuarantineReason = "unmapped_vocabulary" | "unmapped_sellable" | "vat_unresolvable" | "money_mismatch" | "revision_conflict" | "contract_parse_failed";
export interface ChannelScope {
  connectionId: string; channelId: string; connectorKind: string; sellerRef: string; environmentRef: string;
  connectionVersion: number; registryVersion: number; currency: string; regionCode: string;
}
export interface ChannelListingDraft {
  id: string; version: number; scope: ChannelScope; bundleId: string; externalOfferRef: string;
  state: "draft" | "qualified" | "approved"; manualStop: boolean; approvalId: string | null;
}
export interface ChannelBundleBinding {
  bundleId: string; code: string; compositionDigest: string; lockedAt: string | null; fulfillmentMode: string; constraintRef: string | null;
  components: { skuId: string; skuCode: string; quantity: number; isAddon: boolean }[];
}
export interface ChannelOfferObservation {
  observationRef: string; observedAt: string; scope: ChannelScope; externalOfferRef: string; revisionRef: string | null;
  controlledDigest: string; products: { externalProductRef: string; quantity: number;
    unitIdentifiers: { kind: string; issuer: string; value: string }[] }[];
  price: { grossMinor: number; currency: string };
  terms: { digest: string; deliveryRef: string; returnsRef: string | null; documentPolicyRef: string; fiscalProfileRef: string };
  sellingState: string; restrictions: string[];
}
export type ChannelBasis = { skuId: string; weightMinor: number; priceListId: string; priceEntryId: string; resolvedAt: string;
  sourceMode: string; sourceAmountKind: string; matchedMinQty: number }[];
export interface ChannelQualification {
  id: string; listingId: string; listingVersion: number; connectionVersion: number; registryVersion: number;
  bundleDigest: string; catalogHead: { protocol: string; headDigest: string | null }; purchaseMode: "one_time";
  sourceDigest: string; policyRef: string; policyDigest: string; offer: ChannelOfferObservation;
  mapping: { skuId: string; externalProductRef: string }[]; basis: ChannelBasis;
  requestedPrice: { grossMinor: number; currency: string }; validUntil: string; disposition: "qualified" | "blocked" | "unknown";
  reasons: { skuId?: string; field?: string; reason: string; nextAction: string }[];
}
export interface ChannelApproval {
  id: string; listingId: string; qualificationId: string; listingVersion: number; approvedBy: string; approvedAt: string;
  bundleDigest: string; requestedPrice: { grossMinor: number; currency: string }; controlledDigest: string;
  termsDigest: string; policyRef: string; firstBasisApprovalId: string; recoveryPolicy: "same_approved_offer_when_ready";
}
export interface ChannelListingDetail {
  listing: ChannelListingDraft; qualification: ChannelQualification | null; currentApproval: ChannelApproval | null;
  firstApproval: ChannelApproval | null; firstQualification: ChannelQualification | null;
}
export interface ChannelPurchaseCapture {
  schemaVersion: "channel.purchase-source.v1"; captureId: string; scope: ChannelScope; namespace: ChannelPurchaseNamespace;
  execution: { actorId: string; jobRunId: string }; providerEventId: string; externalOrderRef: string; externalOrderRevision: string | null;
  normalized: NormalizedChannelOrder; normalizedDigest: string; rawSourceDigest: string;
  products: { externalLineRef: string; externalOfferRef: string; purchasedAt: string; products: { externalProductRef: string; quantityPerSet: number }[] }[];
  capturedAt: string; pagePacketRef: string; retainedRows?: ChannelPurchasedExpandedLine[];
}
export interface ChannelPullProgressState { cursor: string | null; watermark: string | null; generation: number }
export interface ChannelPullCursorReceipt { pagePacketId: string; before: ChannelPullProgressState; after: ChannelPullProgressState }
export interface ChannelPullPage {
  schemaVersion: "channel.pull-page.v1"; pagePacketId: string; scope: ChannelScope; namespace: ChannelPurchaseNamespace;
  execution: { actorId: string; jobRunId: string }; expected: ChannelPullProgressState; request: { from: string | null; limit: number };
  events: { providerEventId: string; externalOrderRef: string | null; externalOrderRevision: string | null;
    occurredAt: string; rawSourceDigest: string; disposition: "purchase" | "unresolved"; captureRef: string | null }[];
  observedHead: { providerEventId: string; occurredAt: string } | null; observedAt: string; next: ChannelPullProgressState;
}
export interface ChannelOrderOpsResponse {
  contractVersion: "channels.ops.v1"; orderId: string; channel: { slug: string; displayName: string; status: string } | null;
  ingest: { ledgerId: string; status: string; externalOrderRef: string; externalOrderRevision: string | null;
    lastError: string | null; updatedAt: string } | null; openQuarantineCount: number;
}
export interface ChannelOrderIngestedPayload {
  contract_version: "channel.order.ingested.v1"; order_id: string; channel_slug: string; external_order_ref: string; ingested_at: string;
}

export interface ExpandedChannelOrderLine {
  externalLineRef: string;
  externalOfferRef: string | null;
  skuCode: string;
  quantity: number;
  unitGrossMinor: number;
  lineGrossMinor: number;
  lineDiscountMinor: number;
  vatRateBps: number | null;
  /** Provenance: null for a line that was already a SKU on the wire. */
  bundleCode: string | null;
  /** How many of the bundle this component came from; null for a pass-through SKU line. */
  bundleQty: number | null;
}

export interface ChannelBundleComponent {
  skuCode: string;
  /** Units of this component in ONE bundle. */
  quantity: number;
  /** The catalogue's reference unit price — a WEIGHT here, never a price the buyer pays. */
  referenceUnitPriceMinor: number | null;
}

export interface ChannelBundleComposition {
  bundleCode: string;
  components: readonly ChannelBundleComponent[];
}

export interface ChannelBundleReadPort {
  /** Every bundle this deployment can sell today, keyed by code. */
  readActiveBundleCompositions(input: {
    currency: string;
  }): Promise<readonly ChannelBundleComposition[]>;
}

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
    purchasedSource?: { page: ChannelPullPage; captures: readonly ChannelPurchaseCapture[] };
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

export interface ChannelConnectorPort {
  readonly capabilities: ChannelConnectorCapabilities;
  readonly orders: ChannelOrderSourcePort;
  readonly listings?: ChannelListingSyncPort;
  readonly stockPrice?: ChannelStockPricePushPort;
  readonly shipments?: ChannelShipmentSyncPort;
}

export interface ChannelIngestLedger {
  id: string;
  status: ChannelIngestStatus;
  orderId: string | null;
  clientId: string | null;
  shippingAddressId: string | null;
  paymentIntentId: string | null;
  externalOrderRevision: string | null;
  /**
   * Set when the far side reported a different revision of an order this deployment has already
   * created. The store mutates NOTHING in that case; the saga quarantines it.
   */
  conflict: "revision_conflict" | null;
  /** The inbound delivery was already logged — a redelivery, not a first sighting. */
  eventReplayed: boolean;
  replayed: boolean;
}

export interface ChannelIngestBuyer {
  clientId: string;
  shippingAddressId: string;
  clientCreated: boolean;
  replayed: boolean;
}

export interface ChannelIngestOrder {
  orderId: string;
  orderRef: string | null;
  replayed: boolean;
}

export interface ChannelQuarantineRecord {
  id: string;
  reason: ChannelQuarantineReason;
  status: "open" | "resolved" | "dismissed";
  vocabulary: string;
}

export interface ChannelIngestStorePort {
  recordInboundEvent(input: {
    channelId: string;
    externalOrderRef: string;
    externalOrderRevision: string | null;
    providerEventId: string;
    normalized: NormalizedChannelOrder;
  }): Promise<ChannelIngestLedger>;

  upsertBuyer(input: {
    ledgerId: string;
    buyer: NormalizedChannelOrder["buyer"];
    shipTo: NormalizedChannelOrder["shipTo"];
  }): Promise<ChannelIngestBuyer>;

  createChannelOrder(input: {
    idempotencyKey: string;
    ledgerId: string;
    /**
     * The component lines an application resolved for the wire's BUNDLE lines, or absent when the
     * order carried none. Absent and empty are different: absent means "write the wire lines",
     * which is the only reading under which a store that never learned about bundles stays correct.
     */
    expandedLines?: readonly ExpandedChannelOrderLine[];
  }): Promise<ChannelIngestOrder>;

  advanceLedger(input: {
    ledgerId: string;
    toStatus: ChannelIngestStatus;
    paymentIntentId?: string | null;
    lastError?: string | null;
  }): Promise<ChannelIngestLedger>;

  quarantine(input: {
    channelId: string | null;
    connectionId: string | null;
    providerEventId: string;
    externalOrderRef: string | null;
    /** The WIRE token verbatim, never a panel label. */
    vocabulary: string;
    reason: ChannelQuarantineReason;
    payload: Record<string, unknown>;
  }): Promise<ChannelQuarantineRecord>;
}

export interface ChannelIngestChannelRecord {
  id: string;
  connectionId: string | null;
  slug: string;
  status: string;
  currency: string;
  connectorProviderKind: string;
  settlementProviderKind: string;
  buyerCommsOwner: string;
  /**
   * How parcels sold on this surface ship: the object an order carries as
   * `metadata.selectedDelivery`, declared once on the channel instead of guessed once per order.
   *
   * `null` means the surface has not said, and admission refuses the order rather than choosing a
   * carrier on a buyer's behalf for a parcel they have already paid for. Read verbatim and never
   * derived from the marketplace's own shipping words, which are a different vocabulary.
   */
  deliverySelection: Record<string, unknown> | null;
}

export interface ChannelIngestChannelReadPort {
  readChannelBySlug(slug: string): Promise<ChannelIngestChannelRecord | null>;
}

export interface ChannelIngestReservationItem {
  orderItemId: string;
  skuId: string;
  quantity: number;
}

export interface ChannelIngestReservationPort {
  reserveChannelOrderItems(input: {
    idempotencyKey: string;
    orderId: string;
    items: readonly ChannelIngestReservationItem[];
    metadata?: Record<string, unknown>;
    /**
     * Whose stock this reservation is against, from the surface's declared delivery selection.
     *
     * NOT OPTIONAL, AND NOT DEFAULTED TO NULL. A reservation created without it draws on local
     * balances, while the same goods sold on the storefront under a provider-backed selection draw
     * on that provider's stock oracle -- two authorities for one shelf, disagreeing quietly. The
     * boundary already stamps the stock authority from this argument; passing it is the whole fix.
     */
    providerKind: string | null;
  }): Promise<{ reservedItemCount: number }>;
}

export interface ChannelIngestOrderItemReadPort {
  readOrderItems(orderId: string): Promise<readonly ChannelIngestReservationItem[]>;
}

export interface ChannelIngestPaymentControlPort {
  createIntent(input: {
    idempotencyKey: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    metadata: Record<string, unknown>;
  }): Promise<{ paymentIntentId: string }>;

  recordAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    provider: string;
    providerAttemptId: string;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  }): Promise<{ paymentAttemptId: string }>;

  ingestSettlementEvent(input: {
    provider: string;
    providerEventId: string;
    providerPaymentId: string;
    paymentIntentId: string;
    amountMinor: number;
    currency: string;
    payload: Record<string, unknown>;
  }): Promise<{ paymentEventId: string }>;

  applySucceeded(input: {
    idempotencyKey: string;
    /**
     * The order this settlement belongs to. Stated by the saga rather than looked up: the control
     * plane's apply boundary takes the order as an argument so it can refuse a settlement aimed at
     * a different order than the intent was minted for, and a rail that had to re-derive it would
     * have nothing to be refused against.
     */
    orderId: string;
    paymentIntentId: string;
    paymentEventId: string;
    occurredAt: string;
  }): Promise<{ orderId: string }>;
}

export interface ChannelPurchaseNamespace { applicationRef: string; channelExternalRef: string | null }

export interface ChannelPurchasedProductFacts {
  externalLineRef: string; externalOfferRef: string; purchasedAt: string;
  products: readonly { externalProductRef: string; quantityPerSet: number }[];
}

export interface ChannelPurchasedExpandedLine extends ExpandedChannelOrderLine {
  retained: { skuId: string; groupIndex: number; listingId: string; bundleDigest: string; firstApprovalId: string;
    firstQualificationId: string; weightMinor: number; normalizationFactor: number };
}

export interface ChannelComponentMoneyGroup {
  skuId: string; skuCode: string; groupIndex: number; quantity: number;
  unitFinalMinor: number; unitDiscountMinor: number; unitGrossMinor: number;
  lineFinalMinor: number; lineDiscountMinor: number; lineGrossMinor: number;
}

export interface ChannelFrozenMoneyComponent { skuId: string; skuCode: string; quantityPerSet: number; weightMinor: number }

export interface ChannelMoneyAllocationInput {
  finalMinor: number; discountMinor: number; purchasedSets: number; components: readonly ChannelFrozenMoneyComponent[];
}

export interface ChannelMoneyAllocation {
  normalizationFactor: number; rawComponents: readonly ChannelFrozenMoneyComponent[]; groups: readonly ChannelComponentMoneyGroup[];
}

export type ChannelBundleExpansionRefusal = { kind: "unmapped_sellable"; vocabulary: string } | { kind: "money_mismatch"; vocabulary: string; detail: string };
export type ChannelBundleExpansion = { ok: true; lines: readonly ExpandedChannelOrderLine[]; expanded: boolean } | { ok: false; refusal: ChannelBundleExpansionRefusal };

export interface ChannelConnectionPullRow {
  connectionId: string; slug: string; connectorProviderKind: string; connectorShape: string;
  pullCursor: string | null; pullWatermarkAt: string | null; pullCaptureGeneration?: number;
}
export interface ChannelConnectionPullPort {
  listPullableConnections(): Promise<readonly ChannelConnectionPullRow[]>;
  recordPullProgress(input: { connectionId: string; pullCursor: string | null; pullWatermarkAt: string | null }): Promise<void>;
}

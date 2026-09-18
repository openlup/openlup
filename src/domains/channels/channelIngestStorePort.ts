import type { ExpandedChannelOrderLine } from "./bundleLineExpansion.js";
import type { NormalizedChannelOrder } from "./orderContracts.js";

// The persistence seam of the channel order ingest saga, stated in the saga's own vocabulary
// rather than in any store's. Every method is one durable step; none exposes a query builder, a
// table name or an RPC name, so a store that is not this shop's can satisfy it.
//
// The saga also needs two rails it does not own — the payment control plane and inventory
// reservations. Those are declared HERE, narrowly, as the four calls the saga actually makes,
// rather than imported from the commerce domain. That is deliberate and it is the wave's
// cross-domain seam decision: `src/domains/commerce/runtimePorts.ts` is not a public cross-domain
// segment, and widening the allowlist to reach it would make every commerce runtime type
// reachable from every domain. Structural typing does the work instead — the existing commerce
// adapters satisfy these interfaces as they stand, and composition passes them in.

/** The saga's ordered lane, in the order it is walked. */
export const CHANNEL_INGEST_ORDERED_STATUSES = [
  "received",
  "buyer_ready",
  "order_created",
  "reserved",
  "settled",
  "done",
] as const;

/** Where a run stops and waits for stock, or for a person. */
export const CHANNEL_INGEST_HALTED_STATUSES = [
  "blocked_stock",
  "quarantined",
  "failed",
] as const;

export type ChannelIngestOrderedStatus = (typeof CHANNEL_INGEST_ORDERED_STATUSES)[number];
export type ChannelIngestHaltedStatus = (typeof CHANNEL_INGEST_HALTED_STATUSES)[number];
export type ChannelIngestStatus = ChannelIngestOrderedStatus | ChannelIngestHaltedStatus;

/** Why a signal was refused. Closed by design: this is a state machine this domain owns. */
export const CHANNEL_QUARANTINE_REASONS = [
  "unmapped_vocabulary",
  "unmapped_sellable",
  "vat_unresolvable",
  "money_mismatch",
  "revision_conflict",
  "contract_parse_failed",
] as const;

export type ChannelQuarantineReason = (typeof CHANNEL_QUARANTINE_REASONS)[number];

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

/** The one selling surface fact the saga reads before it admits an order. */
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

// --- The two borrowed rails, narrowed to what the saga calls -----------------------------------

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

/**
 * The stock refusal, recognised STRUCTURALLY rather than by importing the commerce error class.
 * Both shapes the reservation rail produces are matched: the raw SQLSTATE 23514 the RPC raises
 * (`inventory_reservation_insufficient_available_stock`, and its external-provider sibling), and
 * the commerce conflict error the managed adapter maps it into.
 */
export function isInsufficientStockError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const name = typeof candidate.name === "string" ? candidate.name : "";

  if (/insufficient_available_stock|allocation_incomplete/i.test(message)) return true;
  // The managed adapter collapses the SQLSTATE into its own conflict class and keeps the code.
  return name === "CommerceRuntimeConflictError" && code === "23514";
}

/** Every ordered status, ranked. Halted statuses are unranked, exactly as the store treats them. */
export function channelIngestStatusRank(status: ChannelIngestStatus): number {
  const index = (CHANNEL_INGEST_ORDERED_STATUSES as readonly string[]).indexOf(status);
  return index < 0 ? 0 : index + 1;
}

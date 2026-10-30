import type { ChannelIngestStatus } from "./contracts/index.js";
export type { ChannelIngestLedger, ChannelIngestBuyer, ChannelIngestOrder, ChannelQuarantineRecord, ChannelIngestStorePort, ChannelIngestChannelRecord, ChannelIngestChannelReadPort, ChannelIngestReservationItem, ChannelIngestReservationPort, ChannelIngestOrderItemReadPort, ChannelIngestPaymentControlPort, ChannelIngestOrderedStatus, ChannelIngestHaltedStatus, ChannelIngestStatus, ChannelQuarantineReason } from "./contracts/index.js";



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


/** Why a signal was refused. Closed by design: this is a state machine this domain owns. */
export const CHANNEL_QUARANTINE_REASONS = [
  "unmapped_vocabulary",
  "unmapped_sellable",
  "vat_unresolvable",
  "money_mismatch",
  "revision_conflict",
  "contract_parse_failed",
] as const;


/** The one selling surface fact the saga reads before it admits an order. */


// --- The two borrowed rails, narrowed to what the saga calls -----------------------------------


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

export type { ChannelConnectionPullRow, ChannelConnectionPullPort } from "./contracts/index.js";

// OmniPack fulfilment status vocabulary → local fulfillment statuses.
//
// Source of truth: the OmniPack API `status` (primary) enum, documented at
// https://docs.omnipack.tech (api/v1 + api/v2), live stage getFulfilments
// payloads (2026-07-09, harvested from inbound_provider_events), and vendor
// confirmation (2026-07-24). See config/omnipack-status-dictionary.json.
//
// DESIGN: map on the PRIMARY `status` field, NOT on `subStatus` and NOT on the
// merchant panel labels. The known primary vocabulary is a small, stable axis;
// subStatus remains provider detail that can grow beyond the live-observed and
// vendor-confirmed values in the dictionary. Keying on subStatus (as the
// panel-derived predecessor did) meant every new subStatus silently zeroed the
// pull. Keying on the primary status means new subStatuses ride an already-mapped
// parent, and only a genuinely new PRIMARY status quarantines loudly.

import { FULFILLMENT_STATUS_MAP } from "../../../src/domains/fulfillment/statusMap.js";

export type NormalizedProviderStatus =
  | "new"
  | "in_fulfillment"
  | "ready_for_packing"
  | "awaiting_courier"
  | "shipping"
  | "delivered"
  | "shipping_failed"
  | "returned_to_sender"
  | "cancelled"
  | "suspended";

// Provider strings arrive in varied spelling ("IN_FULFILLMENT", "in_fulfillment",
// "Shipping") — compare on a canonical token so casing/separator drift can never
// silently zero the pull.
export function canonicalStatusToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  return token || null;
}

// Map the provider primary `status` to our normalized enum. subStatus is NOT
// consulted: it is recorded verbatim as evidence but never changes the local
// state (the provider-status mapping lives entirely in the primary status).
// Returns null for an unknown/UNKNOWN primary status → the worker quarantines it
// as omnipack_unknown_provider_status (loud, self-diagnosing) rather than skipping.
export function normalizeStatus(status: string | null): NormalizedProviderStatus | null {
  switch (canonicalStatusToken(status)) {
    case "new":
      return "new";
    case "in_fulfillment":
      return "in_fulfillment";
    case "ready_for_packing":
      return "ready_for_packing";
    case "awaiting_courier":
      return "awaiting_courier";
    case "shipping":
      return "shipping";
    case "delivered":
      return "delivered";
    case "shipping_failed":
      return "shipping_failed";
    case "returned_to_sender":
      return "returned_to_sender";
    case "cancelled":
      return "cancelled";
    case "suspended":
      return "suspended";
    // "unknown" is OmniPack's documented exceptional value ("in general it
    // shouldn't happen") — quarantine it like any unmapped status.
    default:
      return null;
  }
}

// Local fulfillment status vocabulary (the canonical set used across the
// commerce domain): provider_received | picking | packed | in_transit |
// delivered | cancelled | exception. Both ingestion paths — the poller and the
// webhook — map into it here and nowhere else.
//
// A total Record rather than a `switch`: a new member of the union is then a
// compile error instead of a silent fall-through to whatever the last branch
// returned. The webhook path used to carry exactly that hole (its private
// mapper defaulted every unnamed token to `delivered`, the most consequential
// terminal state); routing it through this table removed it.
const LOCAL_STATUS_BY_PROVIDER_STATUS: Record<NormalizedProviderStatus, string> = {
  // Created / on hold at the provider. READY_FOR_EXPORT means validation passed
  // and waits for export to warehouse execution; EXPORTED means handed to
  // warehouse execution. Neither proves a label, stock coverage, WMS
  // acceptance, cut-off passage, or literal picking. Neither is shipped.
  new: "provider_received",
  // Canonical `picking` is the coarse provider-neutral warehouse-preparation
  // bucket; IN_FULFILLMENT evidence does not prove a literal picker action, and
  // it does NOT consume provider stock — see stockConsumedFor below.
  in_fulfillment: "picking",
  // Picking completed, awaiting packing. This is the domain's finished-picking
  // consumption boundary: the webhook path maps the same physical moment
  // (order.picked) to local `packed` and consumes provider stock, so the poller
  // must not lag a state behind (push/pull parity). `packed` is not in the
  // handover set, so no dispatch email fires here.
  ready_for_packing: "packed",
  // Packed, waiting for the courier to collect. Stock is consumed; the parcel
  // is NOT yet handed over, so no dispatch email fires here.
  awaiting_courier: "packed",
  // Courier has the parcel — this is the ship boundary: handover + tracking +
  // the "w drodze" (shipment.dispatched) customer email.
  shipping: "in_transit",
  delivered: "delivered",
  // Shipping failed / order suspended pending merchant clarification / returned
  // to sender / provider-side cancellation: all route to an operational
  // fulfillment_exception hold for OMS review. The verified vendor source emits
  // the existing reassurance-only event before delivery; after durable delivery
  // the hold remains but the future-tense event is suppressed. The distinct
  // provider status is preserved as the hold reason.
  shipping_failed: "exception",
  suspended: "exception",
  returned_to_sender: "exception",
  cancelled: "exception",
};

export function localStatusFor(status: NormalizedProviderStatus): string {
  return LOCAL_STATUS_BY_PROVIDER_STATUS[status];
}

// ---------------------------------------------------------------------------
// The side-effect boundary. ONE definition, consumed by both ingestion paths.
// Until W2 each path restated these two predicates inline, in different words
// and in a different order, and the webhook path had no exception branch at all.
// ---------------------------------------------------------------------------

/**
 * Local statuses at or past durable handover: handover + tracking (+ the
 * shipment.dispatched customer email, which the DB suppresses when the first
 * signal we see is already `delivered`).
 *
 * DERIVED from the status canon's `effects.handover`, so this cannot drift.
 */
export const HANDOVER_LOCAL_STATUSES: ReadonlySet<string> = new Set(
  FULFILLMENT_STATUS_MAP.stages.filter((stage) => stage.effects.handover).flatMap((stage) => stage.localStatus),
);

/**
 * Local statuses that consume provider stock.
 *
 * NOT derived from the canon's `effects.stock`, and that is a finding rather
 * than an oversight: the canon carries `effects` per STAGE, and the `packing`
 * stage owns two local statuses with different stock behaviour — `picking`
 * (warehouse preparation, evidence only) and `packed` (finished picking, stock
 * consumed). Deriving would silently start consuming stock at `picking`, which
 * contradicts the vendor-confirmed A->B dictionary and the finished-picking
 * boundary documented above. `statusMap.test.ts` pins the exact delta so the
 * divergence stays visible until the canon can express a per-status boundary.
 */
export const STOCK_CONSUMED_LOCAL_STATUSES: ReadonlySet<string> = new Set(["packed", "in_transit", "delivered"]);

export function handsOverFor(localStatus: string): boolean {
  return HANDOVER_LOCAL_STATUSES.has(localStatus);
}

export function stockConsumedFor(localStatus: string): boolean {
  return STOCK_CONSUMED_LOCAL_STATUSES.has(localStatus);
}

/** The four writes both ingestion paths perform, in the one order they perform them. */
export interface FulfillmentEffectPort {
  markProviderStockConsumed(input: { idempotencyKey: string; fulfillmentOrderId: string }): Promise<{ replayed: boolean }>;
  markHandedOver(input: { idempotencyKey: string; fulfillmentOrderId: string; suppressDispatched: boolean }): Promise<{ replayed: boolean }>;
  recordTrackingReference(input: {
    idempotencyKey: string;
    orderId: string;
    fulfillmentOrderId: string;
    trackingNumber: string;
    trackingUrl: string | null;
    carrierKind: string | null;
    service: string | null;
    status: "in_transit" | "delivered";
    rawEvent: Record<string, unknown>;
  }): Promise<{ replayed: boolean; readBack: boolean }>;
}

export interface FulfillmentEffectTrackingReference {
  trackingNumber: string;
  trackingUrl?: string | null;
  carrierKind?: string | null;
  service?: string | null;
}

/**
 * Apply the local-status side effects for one observation: stock consumption,
 * durable handover, the tracking references the parcel carries, and the
 * accounting invoice the handover owes — in that order, for both paths. The
 * order is the poller's, which pinned it in a test; the webhook adopted it.
 *
 * `suppressDispatched` is derived here rather than passed: it was
 * `localStatus === "delivered"` at both call sites, which is the same rule
 * written twice. Error policy and counters stay with the caller, because the
 * poller records a failed batch while the webhook must answer the provider.
 */
export async function applyFulfillmentEffects(input: {
  port: FulfillmentEffectPort;
  localStatus: string;
  ids: { orderId: string; fulfillmentOrderId: string };
  payload: Record<string, unknown>;
  trackingRefs: readonly FulfillmentEffectTrackingReference[];
  stockIdempotencyKey: string;
  handoffIdempotencyKey: string;
  trackingIdempotencyKey: (trackingNumber: string) => string;
  issueAccountingInvoice?: () => Promise<void>;
  onReplayed?: () => void;
  onTrackingRecorded?: (result: { replayed: boolean; readBack: boolean }) => void;
}): Promise<void> {
  const { fulfillmentOrderId, orderId } = input.ids;
  if (stockConsumedFor(input.localStatus)) {
    const consumed = await input.port.markProviderStockConsumed({
      idempotencyKey: input.stockIdempotencyKey,
      fulfillmentOrderId,
    });
    if (consumed.replayed) input.onReplayed?.();
  }
  if (!handsOverFor(input.localStatus)) return;

  const handoff = await input.port.markHandedOver({
    idempotencyKey: input.handoffIdempotencyKey,
    fulfillmentOrderId,
    suppressDispatched: input.localStatus === "delivered",
  });
  if (handoff.replayed) input.onReplayed?.();

  for (const trackingRef of input.trackingRefs) {
    const tracking = await input.port.recordTrackingReference({
      idempotencyKey: input.trackingIdempotencyKey(trackingRef.trackingNumber),
      orderId,
      fulfillmentOrderId,
      trackingNumber: trackingRef.trackingNumber,
      trackingUrl: trackingRef.trackingUrl ?? null,
      carrierKind: trackingRef.carrierKind ?? null,
      service: trackingRef.service ?? null,
      status: input.localStatus as "in_transit" | "delivered",
      rawEvent: input.payload,
    });
    input.onTrackingRecorded?.(tracking);
  }
  await input.issueAccountingInvoice?.();
}

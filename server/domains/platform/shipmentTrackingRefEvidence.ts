// Detects shipments the provider reported as handed over while
// `shipment_external_refs` stayed empty (a provider SHIPPING event with an empty
// trackingNumbers array: markHandedOver still fires, the ref loop iterates zero
// times). The dispatched-email trigger then RETURNs without writing an outbox
// row, so no planned communication_email_deliveries row exists and
// customer_email_delivery_missed cannot fire for this case by construction.

export type HandedOverFulfillmentRow = {
  id: string;
  order_id: string;
  status?: string | null;
  handed_over_at?: string | null;
  updated_at?: string | null;
};

export type ShipmentTrackingRefRow = {
  order_id: string;
  active?: boolean | null;
};

export type DeliveredStatusEvidenceRow = {
  fulfillment_order_id?: string | null;
  local_status?: string | null;
};

// Matches the trigger's own status gate:
// `v_fulfillment.status NOT IN ('handed_over', 'in_transit') THEN RETURN`.
export const HANDED_OVER_TRACKING_REF_STATUSES = ["handed_over", "in_transit"];

// A re-check trigger on shipment_external_refs re-emits within seconds of a
// late ref arriving, so only a ref that is still missing an hour after handoff
// is evidence of a stuck shipment rather than of normal write ordering.
export const HANDED_OVER_TRACKING_REF_GRACE_MS = 60 * 60 * 1000;

// This mirrors, in order, the three early returns of the live
// commerce_emit_shipment_dispatched_outbox
// (20260715170000_omnipack_dispatch_convergence.sql:1033-1069, which supersedes
// 20260711170013_shipment_dispatched_ref_arrival_recheck.sql):
//   1. status NOT IN ('handed_over','in_transit')                    -> RETURN
//   2. EXISTS omnipack_status_evidence with local_status 'delivered'  -> RETURN
//   3. jsonb_array_length(active refs for the order) = 0              -> RETURN
// Only a fulfillment that clears 1 and 2 but is stopped by 3 is owed a
// dispatched email it will never get. Mirroring 1 and 3 without 2 would page p1
// on a delivered-first parcel the customer already has; a wider predicate would
// hide shipments the trigger will never email about.
export function countHandedOverWithoutTrackingRef(input: {
  fulfillmentOrders: HandedOverFulfillmentRow[];
  trackingRefs: ShipmentTrackingRefRow[];
  deliveredEvidence: DeliveredStatusEvidenceRow[];
  now: Date;
}): number {
  const cutoff = input.now.getTime() - HANDED_OVER_TRACKING_REF_GRACE_MS;
  // Return 3: join on the *order*, active = true, no condition on the tracking id.
  const orderIdsWithActiveRef = new Set(
    input.trackingRefs.filter((row) => row.active === true).map((row) => row.order_id),
  );
  // Return 2: the SQL compares lower(btrim(coalesce(local_status, ''))), so a
  // capitalised or padded provider value must still exclude the fulfillment.
  const deliveredFulfillmentIds = new Set(
    input.deliveredEvidence
      .filter((row) => text(row.local_status) === "delivered")
      .map((row) => row.fulfillment_order_id),
  );
  return input.fulfillmentOrders.filter((row) => {
    if (!HANDED_OVER_TRACKING_REF_STATUSES.includes(text(row.status))) return false;
    if (deliveredFulfillmentIds.has(row.id)) return false;
    const handedOverAt = timestamp(row.handed_over_at ?? row.updated_at);
    if (handedOverAt <= 0 || handedOverAt > cutoff) return false;
    return !orderIdsWithActiveRef.has(row.order_id);
  }).length;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

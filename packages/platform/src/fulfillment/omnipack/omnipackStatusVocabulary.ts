// Provider status translation only; lifecycle effects remain host-owned.
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
  // the shipment.dispatched customer email.
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


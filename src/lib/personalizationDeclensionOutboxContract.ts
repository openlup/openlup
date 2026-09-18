// Outbox event-type constants for the homepage hero personalization domain.
// Lives in `src/` (not `server/`) so both the server handler/wiring AND the
// shared KNOWN_OUTBOX_EVENT_TYPES list can import the single literal — and in
// `src/lib/` rather than the withheld `src/domains/personalization/`, mirroring
// src/lib/fulfillmentHandoffOutboxContract.ts.

export const PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE =
  "personalization.declension_requested";

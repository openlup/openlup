// Outbox event type of the removed personalization feature. Nothing in this tree produces or
// handles it any more, but the published schema keeps its producing SQL function and an upgraded
// store may hold pending rows. It therefore stays in KNOWN_OUTBOX_EVENT_TYPES, so such a row never
// blocks its aggregate, and server/runtime/outbox/retiredEventHandlers.ts discards it explicitly.

export const PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE =
  "personalization.declension_requested";

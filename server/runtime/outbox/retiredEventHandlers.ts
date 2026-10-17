import type { OutboxHandler } from "@openlup/outbox";

import { PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE } from "../../../src/lib/personalizationDeclensionOutboxContract.js";

/** Reason recorded on every row a retired event type discards. */
export const RETIRED_OUTBOX_EVENT_REASON = "outbox_event_type_retired";

/**
 * Handlers for event types this application no longer produces or consumes, though rows of them
 * can still exist or be enqueued: the published schema keeps the producing SQL function, and a
 * store upgraded from an earlier version may hold pending rows. The type stays in
 * KNOWN_OUTBOX_EVENT_TYPES, so a pending row never blocks its aggregate, and a composition that
 * registers these handlers drains such rows once with a terminal, benign discard instead of
 * leaving them pending or retrying them.
 */
export const RETIRED_OUTBOX_EVENT_TYPES = [PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE] as const;

export function createRetiredOutboxEventHandlers(): OutboxHandler[] {
  return RETIRED_OUTBOX_EVENT_TYPES.map((eventType) => ({
    eventType,
    timeoutMs: 1_000,
    handle: async () => ({ kind: "discard", reason: `${RETIRED_OUTBOX_EVENT_REASON}:${eventType}`, benign: true }),
  }));
}

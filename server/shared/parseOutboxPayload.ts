import type { parseOutboxPayload } from "@openlup/platform/fulfillment";

// Reuse the paid-handoff owner's exact payload parsing and bounded refusal.
export { parseOutboxPayload } from "@openlup/platform/fulfillment";
export type OutboxPayloadParse<T> = ReturnType<typeof parseOutboxPayload<T>>;

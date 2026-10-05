import type { StandardSchemaV1 } from "@openlup/core/standard-schema";
import type { OutboxHandler } from "./contracts.js";
/** @beta Opt-in validation retries invalid payloads; it never changes untyped handlers. */
export function withPayloadSchema<Payload extends Record<string, unknown>>(handler: OutboxHandler, schema: StandardSchemaV1<unknown, Payload>): OutboxHandler {
  return { eventType: handler.eventType, timeoutMs: handler.timeoutMs, async handle(row, signal, execution) {
    const result = await schema["~standard"].validate(row.payload);
    if (result.issues) return { kind: "retry", reason: "outbox_payload_invalid" };
    return handler.handle({ ...row, payload: result.value }, signal, execution);
  } };
}

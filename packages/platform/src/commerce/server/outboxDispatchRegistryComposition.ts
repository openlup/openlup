import type { OutboxHandlerDescriptor } from "@openlup/core/outbox";
import type { OutboxHandlerRegistry } from "../outboxDispatchContracts.js";

/** Preserve native registration order and the timeout sum of same-event handlers. */
export function composeOutboxHandlerDescriptors(
  handlers: readonly OutboxHandlerDescriptor[],
): OutboxHandlerDescriptor[] {
  const descriptors = new Map<string, OutboxHandlerDescriptor>();
  for (const handler of handlers) {
    const existing = descriptors.get(handler.eventType);
    descriptors.set(handler.eventType, {
      eventType: handler.eventType,
      timeoutMs: (existing?.timeoutMs ?? 0) + handler.timeoutMs,
    });
  }
  return [...descriptors.values()];
}

/** Refuse a different claim surface before a worker can call claimBatch. */
export function assertOutboxRegistryDescriptors(
  registry: OutboxHandlerRegistry,
  expected: readonly OutboxHandlerDescriptor[],
): void {
  const actual = [...registry.entries()];
  if (actual.length !== expected.length || actual.some(([key, handler], index) => {
    const descriptor = expected[index];
    return key !== descriptor.eventType || handler.eventType !== key
      || handler.timeoutMs !== descriptor.timeoutMs
      || !Number.isFinite(handler.timeoutMs) || handler.timeoutMs <= 0;
  })) throw new Error("outbox_registry_descriptor_mismatch");
}

import type { OutboxHandler, OutboxHandlerRegistry } from "./contracts.js";
export function claimAllowlist(registry: OutboxHandlerRegistry): string[] {
  return [...registry.keys()];
}

export function uniqueRegistry(handlers: readonly OutboxHandler[]): OutboxHandlerRegistry {
  const registry = new Map<string, OutboxHandler>();
  for (const handler of handlers) {
    const existing = registry.get(handler.eventType);
    registry.set(handler.eventType, existing ? composeHandlers(existing, handler) : handler);
  }
  return registry;
}

// Preserve top-level delivery observations, with first-component precedence.
const DELIVERY_LIFECYCLE_METADATA_KEYS = ["resendId", "providerMessageId", "skipped", "dedupe"] as const;

function hoistDeliveryLifecycleKeys(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const hoisted: Record<string, unknown> = {};
  for (const key of DELIVERY_LIFECYCLE_METADATA_KEYS) {
    if (detail[key] !== undefined) hoisted[key] = detail[key];
  }
  return hoisted;
}

export function composeHandlers(first: OutboxHandler, second: OutboxHandler): OutboxHandler {
  return {
    eventType: first.eventType,
    timeoutMs: first.timeoutMs + second.timeoutMs,
    async handle(row, signal) {
      const firstOutcome = await first.handle(row, signal);
      if (firstOutcome.kind !== "processed") return firstOutcome;
      const secondOutcome = await second.handle(row, signal);
      if (secondOutcome.kind !== "processed") return secondOutcome;
      return {
        kind: "processed",
        detail: {
          // Hoist second first, then first, so the primary (email) handler wins on
          // the rare chance both emit a lifecycle key.
          ...hoistDeliveryLifecycleKeys(secondOutcome.detail),
          ...hoistDeliveryLifecycleKeys(firstOutcome.detail),
          first: firstOutcome.detail ?? {},
          second: secondOutcome.detail ?? {},
        },
      };
    },
  };
}

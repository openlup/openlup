import { createOutbox, runOutboxDispatchWorker, uniqueRegistry, type OutboxHandler, type OutboxDispatchConfig } from "@openlup/outbox";
import { createPostgresOutboxStore, createPostgresOutboxCompactor, POSTGRES_OUTBOX_SCHEMA } from "@openlup/outbox/postgres";
import type { SqlExecutor } from "@openlup/core/readiness";
import type { JobLeasePort } from "@openlup/core/platform-runtime";
/** Reference composition owns its handlers, known vocabulary, triggers and driver. */
export function createReferenceOutbox(input: {
  executor: SqlExecutor; lease: JobLeasePort; handlers: readonly OutboxHandler[];
  knownEventTypes: readonly string[]; config: OutboxDispatchConfig;
}) {
  if (input.handlers.some((h) => typeof h.handle !== "function")) throw new Error("outbox_handler_not_callable");
  const registry = uniqueRegistry(input.handlers.map((h) => Object.freeze({ eventType: h.eventType, timeoutMs: h.timeoutMs, handle: h.handle.bind(h) })));
  const store = createPostgresOutboxStore(input.executor);
  const compactor = createPostgresOutboxCompactor(input.executor);
  const config = { ...input.config }, knownEventTypes = [...input.knownEventTypes];
  const contribution = createOutbox({ store, lease: input.lease, compactor,
    descriptors: [...registry.values()].map(({ eventType, timeoutMs }) => ({ eventType, timeoutMs })),
    buildHandlers: () => registry,
  }, { config, knownEventTypes, requiredSchema: POSTGRES_OUTBOX_SCHEMA, hostLimitSeconds: 60, leaseSeconds: 60, cadenceSeconds: 60,
    prune: { enabled: true, cadenceSeconds: 86400 } });
  return {
    contribution,
    ports: { "@openlup/outbox:store": store, "@openlup/outbox:lease": input.lease, "@openlup/outbox:compactor": compactor },
    // Bound from the actual runnable declarations, rather than a readiness boolean.
    triggers: Object.fromEntries(contribution.schedules.map((schedule) => [`@openlup/outbox:${schedule.id}`, schedule.run])),
    immediate: () => runOutboxDispatchWorker({ store, registry, knownEventTypes,
      config: { ...config, batchSize: 5, softBudgetMs: Math.min(config.softBudgetMs, 15000) } }),
  };
}
export type ReferenceOutbox = ReturnType<typeof createReferenceOutbox>;

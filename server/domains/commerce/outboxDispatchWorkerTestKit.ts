import { vi } from "vitest";
import type {
  OutboxDispatchConfig,
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
  OutboxHandlerRegistry,
  OutboxMarkFailedStatus,
  OutboxQueueDiagnostics,
  OutboxStore,
} from "./outboxDispatchContracts.js";

// Shared fakes for the two outboxDispatchWorker test files (split to honor the
// 300-LOC architecture guardrail). Test-only module.

export const EVENT_TYPE = "commerce.order_draft.created";

export function makeConfig(overrides: Partial<OutboxDispatchConfig> = {}): OutboxDispatchConfig {
  return {
    batchSize: 25,
    maxAttempts: 8,
    visibilitySeconds: 300,
    backoffBaseSeconds: 60,
    backoffCapSeconds: 3600,
    snoozeSeconds: 300,
    maxSnoozes: 48,
    softBudgetMs: 40_000,
    ...overrides,
  };
}

export function makeRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "evt-1",
    created_at: "2026-06-12T10:00:00.000Z",
    available_at: "2026-06-12T10:00:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: "agg-1",
    event_type: EVENT_TYPE,
    idempotency_key: "idem-1",
    status: "processing",
    attempts: 1,
    payload: {},
    error: null,
    metadata: { claimToken: "tok-1" },
    ...overrides,
  };
}

export type FakeStore = OutboxStore & {
  claimBatch: ReturnType<typeof vi.fn>;
  markProcessed: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  releaseUnprocessed: ReturnType<typeof vi.fn>;
};

export type FakeDiagnostics = OutboxQueueDiagnostics & {
  queueStats: ReturnType<typeof vi.fn>;
};

export function makeStore(batches: OutboxEventRow[][] = []): FakeStore {
  const remaining = [...batches];
  return {
    claimBatch: vi.fn(async () => remaining.shift() ?? []),
    markProcessed: vi.fn(async () => ({ applied: true })),
    markFailed: vi.fn(
      async (input: { outcome: string }): Promise<{ status: OutboxMarkFailedStatus }> => ({
        status:
          input.outcome === "snooze" ? "snoozed" : input.outcome === "discard" ? "discarded" : "failed",
      }),
    ),
    releaseUnprocessed: vi.fn(async (items: ReadonlyArray<unknown>) => items.length),
  };
}

export function makeDiagnostics(): FakeDiagnostics {
  return { queueStats: vi.fn(async () => ({ pending: 0 })) };
}

export function makeHandler(
  eventType: string,
  outcome: OutboxHandlerOutcome | ((row: OutboxEventRow, signal: AbortSignal) => Promise<OutboxHandlerOutcome>),
  timeoutMs = 1000,
): OutboxHandler & { handledIds: string[] } {
  const handledIds: string[] = [];
  return {
    eventType,
    timeoutMs,
    handledIds,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      handledIds.push(row.id);
      if (typeof outcome === "function") return outcome(row, signal);
      return outcome;
    },
  };
}

export function makeRegistry(...handlers: OutboxHandler[]): OutboxHandlerRegistry {
  return new Map(handlers.map((handler) => [handler.eventType, handler]));
}

export function makeClock(startMs = 0): { now(): number; advance(ms: number): void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

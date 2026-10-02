// Outbox event contracts shared by the outbox rail, the packages whose
// handlers it runs, and an application's composition. Types and persisted
// string pins only: no I/O, no clock, no store. The store, the execution
// trace, the registry and the run result belong to the outbox rail.

/**
 * One outbox row, field for field as the claim returns it. Every field name is
 * a persisted column name.
 * @beta
 */
export interface OutboxEventRow {
  id: string;
  created_at: string;
  available_at: string;
  processed_at: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  error: string | null;
  metadata: Record<string, unknown>;
}

/**
 * The persisted column names of {@link OutboxEventRow}, in claim order.
 * @beta
 */
export const OUTBOX_EVENT_ROW_FIELDS = [
  "id",
  "created_at",
  "available_at",
  "processed_at",
  "aggregate_type",
  "aggregate_id",
  "event_type",
  "idempotency_key",
  "status",
  "attempts",
  "payload",
  "error",
  "metadata",
] as const satisfies ReadonlyArray<keyof OutboxEventRow>;

/**
 * What a handler returns. The `kind` names are persisted outcome names. A
 * `reason` is never rewritten here: it is the text a store records as the
 * row's `error`. `benign` marks an expected terminal drop, reported as a
 * warning rather than an error. `detail` is merged into the row's `metadata`.
 * @beta
 */
export type OutboxHandlerOutcome =
  | { kind: "processed"; detail?: Record<string, unknown> }
  | { kind: "retry"; reason: string }
  | { kind: "discard"; reason: string; benign?: boolean }
  | { kind: "snooze"; reason: string };

/**
 * The persisted outcome names of {@link OutboxHandlerOutcome}.
 * @beta
 */
export const OUTBOX_HANDLER_OUTCOME_KINDS = [
  "processed",
  "retry",
  "discard",
  "snooze",
] as const satisfies ReadonlyArray<OutboxHandlerOutcome["kind"]>;

/**
 * Per-execution context the rail passes to a handler. It is one object so
 * that later fields extend it without changing the handler's arity. Its
 * contents are in-memory diagnostics: never persist payload or recipient data
 * through it.
 * @beta
 */
export interface OutboxHandlerContext {
  /** Names the step in progress, so a timeout can say where it stopped. */
  setPhase(phase: string): void;
}

/**
 * The abort signal a handler receives, typed structurally so the kernel names
 * no host global. The `AbortSignal` of browsers and Node.js satisfies it. A
 * handler that forwards the signal to an API typed `AbortSignal` may declare
 * its own parameter as `AbortSignal`.
 * @beta
 */
export interface OutboxAbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * Handles one event type. Delivery is at least once and ordered per aggregate
 * only, so a handler is idempotent on `row.id` or `row.idempotency_key`. The
 * signal aborts at `timeoutMs`; handler I/O honours it, so a timed-out side
 * effect cannot complete after the row is claimed again.
 * @beta
 */
export interface OutboxHandler {
  readonly eventType: string;
  readonly timeoutMs: number;
  handle(
    row: OutboxEventRow,
    signal: OutboxAbortSignal,
    ctx?: OutboxHandlerContext,
  ): Promise<OutboxHandlerOutcome>;
}

/** @beta */
export type {
  OutboxEventTypeDeclaration,
  OutboxEventTypeDeclarationState,
  OutboxEventTypeEntry,
} from "./vocabulary.js";
/** @beta */
export {
  PLATFORM_OUTBOX_EVENT_TYPES,
  matchOutboxEventTypeDeclaration,
} from "./vocabulary.js";

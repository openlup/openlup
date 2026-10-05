import type { OutboxEventRow, OutboxHandler } from "@openlup/outbox";
export type { OutboxEventRow, OutboxHandler, OutboxHandlerOutcome, OutboxHandlerExecutionContext } from "@openlup/outbox";
export { OutboxHandlerExecutionTrace } from "@openlup/outbox";
// Pure contracts for the outbox dispatcher. No IO, no Supabase client, no
// process.env reads, and no event-type string literals — event types live in
// the handler registry so the claim allowlist stays the single source of truth.
// SQL counterpart: supabase/migrations/*_outbox_dispatch_rpcs.sql (outbox_*).

export interface CheckoutEmailOutboxReconcileResult {
  checked: { paid: number; failed: number; expired: number };
  inserted: {
    commerceOrderPaid: number;
    commerceOrderPaidEmail: number;
    commercePaymentFailed: number;
    commerceCheckoutExpired: number;
  };
}

export interface CheckoutEmailOutboxReconcilePort {
  reconcile(limit: number): Promise<CheckoutEmailOutboxReconcileResult>;
}

export interface ReorderReminderEnqueueResult {
  enqueued: number;
}

export interface ReorderReminderEnqueuePort {
  enqueue(limit: number): Promise<ReorderReminderEnqueueResult>;
}

export interface ReviewRequestEnqueuePort {
  enqueueRequests(limit: number): Promise<number>;
  enqueueEffects(limit: number): Promise<number>;
}

export type OutboxHandlerRegistry = ReadonlyMap<string, OutboxHandler>;

export type OutboxMarkFailedStatus = "failed" | "discarded" | "snoozed" | "missed";

export interface OutboxStore {
  /** Read-only preflight used to admit a terminal handler when active providers are unavailable. */
  hasPendingEventType?(eventType: string): Promise<boolean>;
  claimBatch(input: {
    eventTypes: readonly string[];
    knownEventTypes?: readonly string[];
    batchSize: number;
    visibilitySeconds: number;
    maxAttempts: number;
  }): Promise<OutboxEventRow[]>;
  markProcessed(input: {
    eventId: string;
    claimToken: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ applied: boolean }>;
  markFailed(input: {
    eventId: string;
    claimToken: string;
    error: string;
    outcome: "retry" | "discard" | "snooze";
    baseDelaySeconds: number;
    maxDelaySeconds: number;
    maxAttempts: number;
    snoozeSeconds: number;
  }): Promise<{ status: OutboxMarkFailedStatus }>;
  releaseUnprocessed(
    items: ReadonlyArray<{ eventId: string; claimToken: string }>,
    delaySeconds: number,
  ): Promise<number>;
}

/** Managed-only best-effort queue observation, separate from core claim/ack policy. */
export interface OutboxQueueDiagnostics {
  queueStats(): Promise<Record<string, unknown>>;
}

export interface Clock {
  now(): number;
}

export interface OutboxDispatchRunResult {
  ok: boolean;
  checked: number;
  updated: number;
  failures: number;
  skipped: boolean;
  reason?: string;
  claimed: number;
  processed: number;
  retried: number;
  snoozed: number;
  discarded: number;
  released: number;
  duplicateInRun: number;
  leaseLost: number;
  batches: number;
  runMs: number;
  byEventType: Record<string, Record<string, number>>;
  discardedEventIds: string[];
  queue?: Record<string, unknown>;
}

// Vercel kills the function at maxDuration; the visibility floor keeps a
// claimed row invisible for >= 5x that, so a dying invocation can never
// overlap the next claim of the same row. outbox-dispatch.ts must keep its
// `config = { maxDuration: 60 }` literal equal to this constant (asserted in
// outboxDispatchJob.test.ts).
export const OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS = 60;
export const OUTBOX_DISPATCH_MIN_VISIBILITY_SECONDS =
  5 * OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS;

export interface OutboxDispatchConfig {
  batchSize: number;
  maxAttempts: number;
  visibilitySeconds: number;
  backoffBaseSeconds: number;
  backoffCapSeconds: number;
  snoozeSeconds: number;
  maxSnoozes: number;
  softBudgetMs: number;
}

const CONFIG_BOUNDS = {
  batchSize: { env: "COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE", def: 25, min: 1, max: 100 },
  maxAttempts: { env: "COMMERCE_OUTBOX_DISPATCH_MAX_ATTEMPTS", def: 8, min: 1, max: 20 },
  visibilitySeconds: {
    env: "COMMERCE_OUTBOX_DISPATCH_VISIBILITY_SECONDS",
    def: 300,
    min: OUTBOX_DISPATCH_MIN_VISIBILITY_SECONDS,
    max: 3600,
  },
  backoffBaseSeconds: { env: "COMMERCE_OUTBOX_DISPATCH_BACKOFF_BASE_SECONDS", def: 60, min: 5, max: 3600 },
  backoffCapSeconds: { env: "COMMERCE_OUTBOX_DISPATCH_BACKOFF_CAP_SECONDS", def: 3600, min: 5, max: 86_400 },
  snoozeSeconds: { env: "COMMERCE_OUTBOX_DISPATCH_SNOOZE_SECONDS", def: 300, min: 60, max: 3600 },
  maxSnoozes: { env: "COMMERCE_OUTBOX_DISPATCH_MAX_SNOOZES", def: 48, min: 1, max: 1000 },
  // Max keeps a >= 15s tail under the cron's hard kill: drain stop + in-flight
  // handler + marks + queue stats + finishJobRun must all fit after the budget.
  softBudgetMs: {
    env: "COMMERCE_OUTBOX_DISPATCH_SOFT_BUDGET_MS",
    def: 40_000,
    min: 5000,
    max: OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS * 1000 - 15_000,
  },
} as const;

function readBoundedInt(
  env: Record<string, string | undefined>,
  bound: { env: string; def: number; min: number; max: number },
): number {
  const raw = env[bound.env];
  if (raw === undefined || raw.trim() === "") return bound.def;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[outbox-dispatch] invalid ${bound.env}=${raw}; using default ${bound.def}`);
    return bound.def;
  }
  const clamped = Math.min(Math.max(parsed, bound.min), bound.max);
  if (clamped !== parsed) {
    console.warn(`[outbox-dispatch] ${bound.env}=${parsed} clamped to ${clamped}`);
  }
  return clamped;
}

export function readOutboxDispatchConfig(
  env: Record<string, string | undefined>,
): OutboxDispatchConfig {
  const config: OutboxDispatchConfig = {
    batchSize: readBoundedInt(env, CONFIG_BOUNDS.batchSize),
    maxAttempts: readBoundedInt(env, CONFIG_BOUNDS.maxAttempts),
    visibilitySeconds: readBoundedInt(env, CONFIG_BOUNDS.visibilitySeconds),
    backoffBaseSeconds: readBoundedInt(env, CONFIG_BOUNDS.backoffBaseSeconds),
    backoffCapSeconds: readBoundedInt(env, CONFIG_BOUNDS.backoffCapSeconds),
    snoozeSeconds: readBoundedInt(env, CONFIG_BOUNDS.snoozeSeconds),
    maxSnoozes: readBoundedInt(env, CONFIG_BOUNDS.maxSnoozes),
    softBudgetMs: readBoundedInt(env, CONFIG_BOUNDS.softBudgetMs),
  };
  if (config.backoffCapSeconds < config.backoffBaseSeconds) {
    console.warn(
      `[outbox-dispatch] backoff cap ${config.backoffCapSeconds}s below base ${config.backoffBaseSeconds}s; raising cap to base`,
    );
    config.backoffCapSeconds = config.backoffBaseSeconds;
  }
  return config;
}

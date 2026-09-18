import {
  SubscriptionCycleSnapshotError,
  type SnapshotSupabaseClient,
} from "./buildSubscriptionCycleSnapshots.js";

/**
 * Resolves `(cycleNumber, retryAttempt, providerAttemptSequence)` for
 * `(subscriptionId, scheduledAt)`.
 *
 * - New cycle (no row matches `scheduledAt`): `cycleNumber = max + 1`, attempt 0.
 * - Retry/replay (a cycle already exists for this `scheduledAt` — a
 *   `retry_scheduled` decline being re-driven): REUSE the persisted
 *   `cycle_number` so the cycle-order idempotency fingerprint matches the
 *   original and `subscription_create_cycle_order_with_outbox` REPLAYS the
 *   existing order instead of raising `subscription_cycle_order_idempotency_conflict`.
 *   Recomputing `max + 1` (cycles 1 + 2 → 3) is what corrupted the fingerprint
 *   before (CJ01-P). Also surfaces the persisted `retry_attempt` so the charge
 *   orchestrator mints a FRESH per-attempt provider key (Stripe rejects reusing
 *   a declined attempt's key with a re-bound card). Separately,
 *   `provider_attempt_sequence` advances only after operator proof that a
 *   prepared attempt never reached the provider, so no customer retry budget is
 *   burned for a no-ack local orphan.
 *
 * `scheduledAt` matches by epoch millis — the due-RPC echoes the cycle's
 * `scheduled_at`, so the compare is exact regardless of timestamp serialization.
 *
 * Kept separate from `buildSubscriptionCycleSnapshots` so that file stays under
 * the 300 LOC architecture guardrail.
 */

interface CycleIdentityRow {
  cycle_number?: unknown;
  scheduled_at?: unknown;
  retry_attempt?: unknown;
  provider_attempt_sequence?: unknown;
}

export interface SubscriptionCycleIdentity {
  cycleNumber: number;
  retryAttempt: number;
  providerAttemptSequence: number;
}

export async function resolveSubscriptionCycleIdentity(
  client: SnapshotSupabaseClient,
  subscriptionId: string,
  scheduledAt: string,
): Promise<SubscriptionCycleIdentity> {
  const { data, error } = await client
    .from("subscription_cycles")
    .select("cycle_number, scheduled_at, retry_attempt, provider_attempt_sequence")
    .eq("subscription_id", subscriptionId)
    .order("cycle_number", { ascending: false });
  if (error) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_cycles read failed: ${error.message ?? "unknown"}`,
      subscriptionId,
      { cause: error },
    );
  }
  const rows = Array.isArray(data) ? (data as CycleIdentityRow[]) : [];
  const scheduledMs = toEpochMs(scheduledAt);
  const match =
    scheduledMs === null
      ? undefined
      : rows.find(
          (r) => typeof r.cycle_number === "number" && toEpochMs(r.scheduled_at) === scheduledMs,
        );
  if (match) {
    return {
      cycleNumber: match.cycle_number as number,
      retryAttempt: typeof match.retry_attempt === "number" ? match.retry_attempt : 0,
      providerAttemptSequence: typeof match.provider_attempt_sequence === "number"
        ? match.provider_attempt_sequence
        : 0,
    };
  }
  const top = rows[0]?.cycle_number;
  return {
    cycleNumber: (typeof top === "number" ? top : 0) + 1,
    retryAttempt: 0,
    providerAttemptSequence: 0,
  };
}

function toEpochMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

import { nextRetryAttemptAt } from "./cycleHardening.js";
import type { SubscriptionCycleStatus } from "./types.js";
import type {
  CycleMutationResult,
  EngineCycle,
  EngineEvent,
  EngineSubscription,
  SubscriptionEngineResult,
} from "./subscriptionEngineTypes.js";
import {
  addCadenceDays,
  failure,
  isTerminalCycle,
  makeEvent,
  parseIso,
  success,
  touchSubscription,
} from "./subscriptionEngineUtils.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** @beta */
export function recordPaymentSuccess(input: {
  subscription: EngineSubscription;
  cycle: EngineCycle;
  paidAt: string;
  recordedAt: string;
}): SubscriptionEngineResult<{
  subscription: EngineSubscription;
  cycle: EngineCycle;
  events: EngineEvent[];
}> {
  const paidAt = parseIso(input.paidAt);
  if (!paidAt) return failure("invalid_timestamp", "paidAt must be a valid ISO timestamp");
  const recordedAt = parseIso(input.recordedAt);
  if (!recordedAt) return failure("invalid_timestamp", "recordedAt must be a valid ISO timestamp");
  if (isTerminalCycle(input.cycle)) {
    return failure("terminal_cycle", "terminal cycles cannot be paid");
  }

  // The next cycle is one cadence past the CYCLE'S OWN scheduled instant, not past
  // the moment the money arrived: a late payment must not silently shorten the
  // interval the customer bought. The whole days the payment was late are then
  // ADDED, because a delivery that arrives late shifts the whole subscription
  // later rather than letting the next one stack up behind it.
  //
  // Lateness is measured to the EARLIER of the payment instant and the instant we
  // recorded it, so a provider timestamp from the future cannot inflate the shift
  // and push the next charge out past what the customer actually owes.
  //
  // ⛔ The outer Math.max is the load-bearing part and is NOT an optimisation.
  // It is a monotonic clamp: `nextCycleAt` may only ever move LATER, never
  // earlier. Without it, a replayed webhook, an out-of-order settlement, or a
  // manual correction applied against an older cycle could compute an EARLIER
  // instant and pull a charge forward into a window the subscriber has already
  // been billed for — the one failure mode this rail must never have. The same
  // clamp is spelled `GREATEST` in the SQL delivery-alignment rail for exactly
  // this reason; the two are one rule with two spellings.
  //
  // `Date.parse(...) || 0` is deliberate rather than defensive noise: a
  // subscription whose stored instant is unreadable clamps against the epoch,
  // which yields the computed instant, instead of poisoning the whole expression
  // with NaN and returning an invalid date. Cadence keeps its own call so its own
  // validity guard still fires and still reports the right error, and `toJSON()`
  // answers null past the representable range rather than throwing, which is why
  // the shift is range-checked below instead of trusted.
  const onTimeNextCycleAt = addCadenceDays(input.cycle.scheduledAt, input.cycle.templateSnapshot.cadence_days);
  if (!onTimeNextCycleAt) return failure("invalid_timestamp", "cycle.scheduledAt must be a valid ISO timestamp");

  const shiftedByDays = Math.max(0, Math.floor(
    (Math.min(paidAt.getTime(), recordedAt.getTime()) - Date.parse(input.cycle.scheduledAt)) / DAY_MS,
  ));
  const nextCycleAt = new Date(Math.max(
    Date.parse(input.subscription.nextCycleAt) || 0,
    Date.parse(onTimeNextCycleAt) + shiftedByDays * DAY_MS,
  )).toJSON();
  if (!nextCycleAt) {
    return failure("invalid_timestamp", "payment shift exceeds the supported timestamp range");
  }
  const paidAtIso = paidAt.toISOString();

  const cycle: EngineCycle = {
    ...input.cycle,
    status: "paid",
    paidAt: paidAtIso,
    retryAttempt: input.cycle.retryAttempt,
    nextRetryAt: null,
    failureReason: null,
  };
  const subscription = touchSubscription(input.subscription, recordedAt.toISOString(), { nextCycleAt });

  return success({
    subscription,
    cycle,
    events: [
      makeEvent({
        eventType: "subscription.cycle_paid",
        subscription,
        cycleNumber: cycle.cycleNumber,
        idempotencyKey: `${cycle.engineIdempotencyKey}:cycle_paid`,
        occurredAt: paidAtIso,
        payload: { paidAt: cycle.paidAt, nextCycleAt },
      }),
      makeEvent({
        eventType: "subscription.next_cycle_at_updated",
        subscription,
        cycleNumber: cycle.cycleNumber,
        idempotencyKey: `${cycle.engineIdempotencyKey}:next_cycle_at_updated`,
        occurredAt: paidAtIso,
        payload: {
          nextCycleAt,
          basedOnScheduledAt: cycle.scheduledAt,
          basedOnPaidAt: cycle.paidAt,
          shiftedByDays,
        },
      }),
    ],
  });
}

/** @beta */
export function recordPaymentFailure(input: {
  cycle: EngineCycle;
  failedAt: string;
  reason: string;
  failureClass?: string | null;
}): SubscriptionEngineResult<CycleMutationResult> {
  const failedAt = parseIso(input.failedAt);
  if (!failedAt) return failure("invalid_timestamp", "failedAt must be a valid ISO timestamp");
  if (isTerminalCycle(input.cycle)) {
    return failure("terminal_cycle", "terminal cycles cannot be retried");
  }

  const retryAttempt = input.cycle.retryAttempt + 1;
  // The ladder owns its terminal decision.
  const nextRetryAt = nextRetryAttemptAt(
    failedAt.toISOString(),
    retryAttempt,
    undefined,
    input.failureClass,
  );
  const status: SubscriptionCycleStatus = nextRetryAt ? "retry_scheduled" : "payment_failed";
  const cycle: EngineCycle = {
    ...input.cycle,
    status,
    retryAttempt,
    nextRetryAt,
    failureReason: input.reason,
  };

  const events: EngineEvent[] = [
    {
      eventType: "subscription.payment_failed",
      subscriptionId: cycle.subscriptionId,
      cycleNumber: cycle.cycleNumber,
      idempotencyKey: `${cycle.engineIdempotencyKey}:payment_failed:${retryAttempt}`,
      occurredAt: failedAt.toISOString(),
      payload: { reason: input.reason, retryAttempt },
    },
  ];

  if (nextRetryAt) {
    events.push({
      eventType: "subscription.retry_scheduled",
      subscriptionId: cycle.subscriptionId,
      cycleNumber: cycle.cycleNumber,
      idempotencyKey: `${cycle.engineIdempotencyKey}:retry_scheduled:${retryAttempt}`,
      occurredAt: failedAt.toISOString(),
      payload: { nextRetryAt, retryAttempt },
    });
  }

  return success({ cycle, events });
}

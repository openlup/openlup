import { describe, expect, it } from "vitest";
import {
  planSubscriptionCycle,
  recordPaymentFailure,
  recordPaymentSuccess,
} from "../src/subscription/index.js";
import { baseTemplate, firstCycleAt, makeSubscription, now, pricingSnapshot, unwrap } from "./subscriptionFixtures.js";

describe("subscription payment lifecycle", () => {
  // The cadence is still measured from the CYCLE, not from the wall-clock instant the
  // money arrived -- that is what keeps the 00:30 time of day across a DST boundary.
  // What was added is the whole days the payment was late, so a recovery that took two
  // days moves the next cycle out two days instead of shortening the customer's gap.
  it("advances a whole cadence from the scheduled time, plus the whole days the payment was late", () => {
    const subscription = makeSubscription({
      nextCycleAt: "2026-03-29T00:30:00.000Z",
      template: { ...baseTemplate, cadence_days: 14 },
    });
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 3,
      now: "2026-03-30T08:00:00.000Z",
      pricingSnapshot,
      idempotencyKey: "dst-example",
    }));
    const paid = unwrap(recordPaymentSuccess({
      subscription,
      cycle: planned.cycle,
      paidAt: "2026-03-31T21:45:00.000Z",
      recordedAt: "2026-03-31T21:45:00.000Z",
    }));

    expect(paid.cycle).toMatchObject({ status: "paid", paidAt: "2026-03-31T21:45:00.000Z" });
    // Scheduled 2026-03-29T00:30Z, paid 2026-03-31T21:45Z: 2 days 21h15m, which
    // truncates to 2 whole days. 2026-03-29T00:30Z + (2 + 14) days = 2026-04-14T00:30Z.
    // The time of day is preserved across the DST boundary exactly as before.
    expect(paid.subscription.nextCycleAt).toBe("2026-04-14T00:30:00.000Z");
    expect(paid.events.at(-1)?.payload).toMatchObject({
      basedOnScheduledAt: "2026-03-29T00:30:00.000Z",
      basedOnPaidAt: "2026-03-31T21:45:00.000Z",
      shiftedByDays: 2,
    });
  });

  it("treats an early payment as a no-op rather than pulling the next cycle in", () => {
    const subscription = makeSubscription({
      nextCycleAt: "2026-03-29T00:30:00.000Z",
      template: { ...baseTemplate, cadence_days: 14 },
    });
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 3,
      now: "2026-03-25T08:00:00.000Z",
      pricingSnapshot,
      idempotencyKey: "early-example",
    }));
    const paid = unwrap(recordPaymentSuccess({
      subscription,
      cycle: planned.cycle,
      paidAt: "2026-03-27T00:30:00.000Z",
      recordedAt: "2026-03-27T00:30:00.000Z",
    }));

    expect(paid.subscription.nextCycleAt).toBe("2026-04-12T00:30:00.000Z");
    expect(paid.events.at(-1)?.payload).toMatchObject({ shiftedByDays: 0 });
  });

  it("leaves an anchor another rail already moved further out untouched", () => {
    // A delivery-side rail extends this date when a parcel is late or replaced. A
    // settlement landing afterwards must not overwrite it with an earlier one.
    const subscription = makeSubscription({
      nextCycleAt: "2027-01-01T00:30:00.000Z",
      template: { ...baseTemplate, cadence_days: 14 },
    });
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 3,
      now: "2026-03-30T08:00:00.000Z",
      pricingSnapshot,
      idempotencyKey: "already-later-example",
    }));
    const paid = unwrap(recordPaymentSuccess({
      subscription,
      cycle: { ...planned.cycle, scheduledAt: "2026-03-29T00:30:00.000Z" },
      paidAt: "2026-03-31T21:45:00.000Z",
      recordedAt: "2026-03-31T21:45:00.000Z",
    }));

    expect(paid.subscription.nextCycleAt).toBe("2027-01-01T00:30:00.000Z");
  });

  it("bounds a future provider paidAt by the explicit recordedAt for schedule arithmetic", () => {
    const subscription = makeSubscription({
      nextCycleAt: "2026-03-29T00:30:00.000Z",
      template: { ...baseTemplate, cadence_days: 14 },
    });
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 3,
      now: "2026-03-29T08:00:00.000Z",
      pricingSnapshot,
      idempotencyKey: "future-provider-time-example",
    }));
    const paid = unwrap(recordPaymentSuccess({
      subscription,
      cycle: planned.cycle,
      paidAt: "+275760-09-12T00:00:00.000Z",
      recordedAt: "2026-03-31T21:45:00.000Z",
    }));

    expect(paid.subscription.nextCycleAt).toBe("2026-04-14T00:30:00.000Z");
    expect(paid.subscription.updatedAt).toBe("2026-03-31T21:45:00.000Z");
    expect(paid.cycle.paidAt).toBe("+275760-09-12T00:00:00.000Z");
    expect(paid.events.at(-1)?.payload).toMatchObject({
      basedOnPaidAt: "+275760-09-12T00:00:00.000Z",
      shiftedByDays: 2,
    });
  });

  it("returns a typed timestamp failure for an invalid recordedAt", () => {
    const subscription = makeSubscription();
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "invalid-recorded-time-example",
    }));

    expect(recordPaymentSuccess({
      subscription,
      cycle: planned.cycle,
      paidAt: "2026-06-10T12:00:00.000Z",
      recordedAt: "not-a-timestamp",
    })).toEqual({
      ok: false,
      error: { code: "invalid_timestamp", message: "recordedAt must be a valid ISO timestamp" },
    });
  });

  it("returns a typed timestamp failure when an extreme valid clock would overflow the next cycle", () => {
    const subscription = makeSubscription();
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "overflow-recorded-time-example",
    }));

    expect(recordPaymentSuccess({
      subscription,
      cycle: planned.cycle,
      paidAt: "+275760-09-12T00:00:00.000Z",
      recordedAt: "+275760-09-12T00:00:00.000Z",
    })).toEqual({
      ok: false,
      error: {
        code: "invalid_timestamp",
        message: "payment shift exceeds the supported timestamp range",
      },
    });
  });

  it("returns a typed timestamp failure when cadence from an extreme valid schedule overflows", () => {
    const subscription = makeSubscription({ nextCycleAt: "+275760-09-12T00:00:00.000Z" });
    const planned = unwrap(planSubscriptionCycle({
      subscription: makeSubscription(),
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "overflow-scheduled-time-example",
    }));

    expect(recordPaymentSuccess({
      subscription,
      cycle: { ...planned.cycle, scheduledAt: "+275760-09-12T00:00:00.000Z" },
      paidAt: "+275760-09-12T00:00:00.000Z",
      recordedAt: "+275760-09-12T00:00:00.000Z",
    })).toEqual({
      ok: false,
      error: {
        code: "invalid_timestamp",
        message: "cycle.scheduledAt must be a valid ISO timestamp",
      },
    });
  });

  it("keeps payment failure on the same cycle and idempotency key", () => {
    const subscription = makeSubscription();
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "retry-example",
    }));
    const failed = unwrap(recordPaymentFailure({
      cycle: planned.cycle,
      failedAt: "2026-06-10T12:00:00.000Z",
      reason: "insufficient_funds",
    }));

    expect(failed.cycle).toMatchObject({
      cycleNumber: 2,
      engineIdempotencyKey: "retry-example",
      retryAttempt: 1,
      status: "retry_scheduled",
      nextRetryAt: "2026-06-11T12:00:00.000Z",
      failureReason: "insufficient_funds",
    });
    expect(subscription.nextCycleAt).toBe(firstCycleAt);
  });

  it("stops retries after the configured backoff attempts", () => {
    const planned = unwrap(planSubscriptionCycle({
      subscription: makeSubscription(),
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "retry-cap-example",
    }));
    const failed = unwrap(recordPaymentFailure({
      cycle: {
        ...planned.cycle,
        retryAttempt: 3,
        status: "retry_scheduled",
        nextRetryAt: "2026-06-17T12:00:00.000Z",
      },
      failedAt: "2026-06-17T12:00:00.000Z",
      reason: "card_declined",
    }));

    expect(failed.cycle).toMatchObject({ status: "payment_failed", retryAttempt: 4, nextRetryAt: null });
  });

  it("threads a classified refusal through the shipped retry cadence", () => {
    const planned = unwrap(planSubscriptionCycle({
      subscription: makeSubscription(),
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "classified-retry-example",
    }));
    const failed = unwrap(recordPaymentFailure({
      cycle: planned.cycle,
      failedAt: "2026-06-10T12:00:00.000Z",
      reason: "instrument_revoked",
      failureClass: "hard_do_not_retry",
    }));

    // W9 filled the shipped terminating set with this exact class, so the
    // threading this test was written to prove now has a visible consequence:
    // the engine gives the refusal no next charge at all. The attempt still
    // counts — a refusal that happened is not a refusal that never happened —
    // and the cycle lands terminal rather than scheduled.
    expect(failed.cycle).toMatchObject({
      status: "payment_failed",
      retryAttempt: 1,
      nextRetryAt: null,
    });
  });

  it("still walks the full ladder for a refusal the shipped set does not list", () => {
    // The fail-open control for the case above, at the same rung with the same
    // fixture, so the only difference between the two is the class.
    const planned = unwrap(planSubscriptionCycle({
      subscription: makeSubscription(),
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "unlisted-class-retry-example",
    }));
    const failed = unwrap(recordPaymentFailure({
      cycle: planned.cycle,
      failedAt: "2026-06-10T12:00:00.000Z",
      reason: "issuer_unavailable",
      failureClass: "soft_retryable",
    }));

    expect(failed.cycle).toMatchObject({
      status: "retry_scheduled",
      retryAttempt: 1,
      nextRetryAt: "2026-06-11T12:00:00.000Z",
    });
  });
});

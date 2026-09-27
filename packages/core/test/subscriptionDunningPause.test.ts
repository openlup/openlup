import { describe, expect, it } from "vitest";
import {
  DEFAULT_CYCLE_RETRY_CADENCE,
  addPermanentAddon,
  isDunningLadderExhausted,
  pauseSubscriptionForExpiredDunning,
  planSubscriptionCycle,
  recordPaymentFailure,
  recordPaymentSuccess,
  resumeSubscriptionFromExpiredDunning,
  skipNextCycle,
  slideNextCycle,
  swapTemplateLine,
  type CycleRetryCadence,
  type EngineCycle,
  type EngineSubscription,
} from "../src/subscription/index.js";
import {
  addonVariantId,
  firstCycleAt,
  makeSubscription,
  now,
  pricingSnapshot,
  replacementVariantId,
  secondaryVariantId,
  unwrap,
} from "./subscriptionFixtures.js";

// The sanctioned non-payment rule: a renewal whose refusals ran PAST the last
// rung of the retry ladder pauses an active subscription, and the customer's
// recovery resumes it. Nothing else in the engine suspends a live subscription
// for a reason the owner did not choose. The managed SQL side of the same rule
// is pinned by supabase/tests/subscription_dunning_open_without_retry_test.sql
// (attempt 1 without a schedule stays open and active; attempt 4 expires and
// pauses).

const failedAt = "2026-06-10T11:00:00.000Z";

function plannedCycle(subscription: EngineSubscription = makeSubscription()): EngineCycle {
  return unwrap(planSubscriptionCycle({
    subscription,
    cycleNumber: 2,
    now,
    pricingSnapshot,
    idempotencyKey: "dunning-example",
  })).cycle;
}

// Walks recordPaymentFailure `attempts` times, exactly as a host would.
function refusedCycle(attempts: number, failureClass?: string): EngineCycle {
  let cycle = plannedCycle();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    cycle = unwrap(recordPaymentFailure({ cycle, failedAt, reason: "provider_declined", failureClass })).cycle;
  }
  return cycle;
}

describe("isDunningLadderExhausted", () => {
  it("is false on every rung that still schedules a retry", () => {
    for (const attempts of [1, 2, 3]) {
      const cycle = refusedCycle(attempts);
      expect(cycle.status).toBe("retry_scheduled");
      expect(isDunningLadderExhausted(cycle)).toBe(false);
    }
  });

  it("is true once the refusal runs past the last rung", () => {
    const cycle = refusedCycle(4);
    expect(cycle).toMatchObject({ status: "payment_failed", retryAttempt: 4, nextRetryAt: null });
    expect(isDunningLadderExhausted(cycle)).toBe(true);
  });

  it("is false for a ladder a terminating class cut short on rung one", () => {
    const cycle = refusedCycle(1, "hard_do_not_retry");
    expect(cycle).toMatchObject({ status: "payment_failed", retryAttempt: 1, nextRetryAt: null });
    expect(isDunningLadderExhausted(cycle)).toBe(false);
  });

  it("derives the exhaustion rung from the cadence rather than a constant", () => {
    const shortLadder: CycleRetryCadence = { backoffHours: [24] };
    const cycle = { status: "payment_failed" as const, retryAttempt: 2, nextRetryAt: null };
    expect(isDunningLadderExhausted(cycle, shortLadder)).toBe(true);
    expect(isDunningLadderExhausted(cycle, DEFAULT_CYCLE_RETRY_CADENCE)).toBe(false);
  });

  it("agrees with recordPaymentFailure when both are given the same custom ladder", () => {
    const shortLadder: CycleRetryCadence = { backoffHours: [24] };
    let cycle = plannedCycle();
    cycle = unwrap(recordPaymentFailure({ cycle, failedAt, reason: "provider_declined", cadence: shortLadder })).cycle;
    expect(cycle).toMatchObject({ status: "retry_scheduled", retryAttempt: 1 });
    expect(isDunningLadderExhausted(cycle, shortLadder)).toBe(false);
    cycle = unwrap(recordPaymentFailure({ cycle, failedAt, reason: "provider_declined", cadence: shortLadder })).cycle;
    expect(cycle).toMatchObject({ status: "payment_failed", retryAttempt: 2, nextRetryAt: null });
    expect(isDunningLadderExhausted(cycle, shortLadder)).toBe(true);
    expect(unwrap(pauseSubscriptionForExpiredDunning({
      subscription: makeSubscription(),
      cycle,
      now: failedAt,
      cadence: shortLadder,
    })).subscription.status).toBe("paused");
  });

  it("is false for a cycle that is not refused, or still has a schedule", () => {
    expect(isDunningLadderExhausted({ status: "paid", retryAttempt: 9, nextRetryAt: null })).toBe(false);
    expect(isDunningLadderExhausted({ status: "payment_failed", retryAttempt: 9, nextRetryAt: failedAt })).toBe(false);
  });
});

describe("pauseSubscriptionForExpiredDunning", () => {
  it("pauses an active subscription once the ladder is exhausted, without moving the schedule", () => {
    const subscription = makeSubscription();
    const cycle = refusedCycle(4);
    const paused = unwrap(pauseSubscriptionForExpiredDunning({ subscription, cycle, now: failedAt }));

    expect(paused.subscription).toMatchObject({ status: "paused", nextCycleAt: subscription.nextCycleAt });
    expect(paused.events).toEqual([
      expect.objectContaining({
        eventType: "subscription.paused",
        cycleNumber: 2,
        idempotencyKey: "dunning-example:subscription_paused",
        payload: { reason: "payment_failed_expired", retryAttempt: 4, failureReason: "provider_declined" },
      }),
    ]);
  });

  it("refuses below exhaustion and leaves the subscription active", () => {
    for (const cycle of [refusedCycle(1), refusedCycle(3), refusedCycle(1, "hard_do_not_retry"), plannedCycle()]) {
      expect(pauseSubscriptionForExpiredDunning({ subscription: makeSubscription(), cycle, now: failedAt }))
        .toMatchObject({ ok: false, error: { code: "dunning_not_exhausted" } });
    }
  });

  it("returns a subscription that is not active unchanged, with no event, so a replay is harmless", () => {
    const cycle = refusedCycle(4);
    for (const status of ["paused", "cancelled", "completed"] as const) {
      const subscription = makeSubscription({ status });
      const result = unwrap(pauseSubscriptionForExpiredDunning({ subscription, cycle, now: failedAt }));
      expect(result.subscription).toEqual(subscription);
      expect(result.events).toEqual([]);
    }
  });

  it("refuses a cycle that belongs to another subscription", () => {
    const cycle = { ...refusedCycle(4), subscriptionId: "sub-other" };
    expect(pauseSubscriptionForExpiredDunning({ subscription: makeSubscription(), cycle, now: failedAt }))
      .toMatchObject({ ok: false, error: { code: "invalid_transition" } });
  });

  it("refuses an unreadable clock", () => {
    expect(pauseSubscriptionForExpiredDunning({ subscription: makeSubscription(), cycle: refusedCycle(4), now: "x" }))
      .toMatchObject({ ok: false, error: { code: "invalid_timestamp" } });
  });
});

describe("resumeSubscriptionFromExpiredDunning", () => {
  const resumeAt = "2026-07-01T09:00:00.000Z";

  function dunningPaused() {
    const cycle = refusedCycle(4);
    const { subscription } = unwrap(pauseSubscriptionForExpiredDunning({
      subscription: makeSubscription(),
      cycle,
      now: failedAt,
    }));
    return { subscription, cycle };
  }

  it("resumes, skips the uncollected cycle and re-arms two days out", () => {
    const { subscription, cycle } = dunningPaused();
    const resumed = unwrap(resumeSubscriptionFromExpiredDunning({
      subscription,
      cycle,
      now: resumeAt,
      paymentMethodRef: "pm-replacement",
      paymentMethodKind: "card",
    }));

    expect(resumed.subscription).toMatchObject({
      status: "active",
      nextCycleAt: "2026-07-03T09:00:00.000Z",
      paymentMethodRef: "pm-replacement",
      paymentMethodKind: "card",
    });
    expect(resumed.cycle).toMatchObject({ status: "skipped", nextRetryAt: null, paidAt: null });
    expect(resumed.events.map((event) => event.eventType)).toEqual([
      "subscription.cycle_skipped",
      "subscription.resumed",
      "subscription.next_cycle_at_updated",
    ]);
    expect(resumed.events[1]?.payload).toMatchObject({ resumedAfterExpiredDunning: true, skippedCycleNumber: 2 });
    expect(new Set(resumed.events.map((event) => event.idempotencyKey)).size).toBe(3);
  });

  it("keeps the stored method when no replacement is given, and its kind when only a ref is", () => {
    const { subscription, cycle } = dunningPaused();
    expect(unwrap(resumeSubscriptionFromExpiredDunning({ subscription, cycle, now: resumeAt })).subscription)
      .toMatchObject({ paymentMethodRef: "pm-example", paymentMethodKind: "card" });
    expect(unwrap(resumeSubscriptionFromExpiredDunning({
      subscription,
      cycle,
      now: resumeAt,
      paymentMethodRef: "pm-new",
      paymentMethodKind: "  ",
    })).subscription).toMatchObject({ paymentMethodRef: "pm-new", paymentMethodKind: "card" });
    expect(unwrap(resumeSubscriptionFromExpiredDunning({
      subscription,
      cycle,
      now: resumeAt,
      paymentMethodRef: "pm-new",
      paymentMethodKind: " sepa_debit ",
    })).subscription).toMatchObject({ paymentMethodKind: "sepa_debit" });
  });

  it("refuses when nothing chargeable is stored or supplied", () => {
    const { subscription, cycle } = dunningPaused();
    expect(resumeSubscriptionFromExpiredDunning({
      subscription: { ...subscription, paymentMethodRef: null },
      cycle,
      now: resumeAt,
      paymentMethodRef: " ",
    })).toMatchObject({ ok: false, error: { code: "missing_payment_method" } });
  });

  it("refuses a subscription that is not paused", () => {
    const cycle = refusedCycle(4);
    for (const status of ["active", "cancelled", "completed"] as const) {
      expect(resumeSubscriptionFromExpiredDunning({ subscription: makeSubscription({ status }), cycle, now: resumeAt }))
        .toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    }
  });

  it("refuses a cycle that did not exhaust the ladder, or belongs elsewhere", () => {
    const { subscription } = dunningPaused();
    expect(resumeSubscriptionFromExpiredDunning({ subscription, cycle: refusedCycle(2), now: resumeAt }))
      .toMatchObject({ ok: false, error: { code: "dunning_not_exhausted" } });
    expect(resumeSubscriptionFromExpiredDunning({
      subscription,
      cycle: { ...refusedCycle(4), subscriptionId: "sub-other" },
      now: resumeAt,
    })).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
  });

  it("refuses an unreadable clock, and a restart past the representable range", () => {
    const { subscription, cycle } = dunningPaused();
    expect(resumeSubscriptionFromExpiredDunning({ subscription, cycle, now: "x" }))
      .toMatchObject({ ok: false, error: { code: "invalid_timestamp" } });
    expect(resumeSubscriptionFromExpiredDunning({ subscription, cycle, now: "+275760-09-12T00:00:00.000Z" }))
      .toMatchObject({ ok: false, error: { code: "invalid_timestamp" } });
  });

  it("never pulls a stored future cycle earlier", () => {
    const { subscription, cycle } = dunningPaused();
    const later = { ...subscription, nextCycleAt: "2026-08-01T00:00:00.000Z" };
    const resumed = unwrap(resumeSubscriptionFromExpiredDunning({ subscription: later, cycle, now: resumeAt }));
    expect(resumed.subscription.nextCycleAt).toBe("2026-08-01T00:00:00.000Z");
    expect(resumed.events.map((event) => event.eventType)).not.toContain("subscription.next_cycle_at_updated");
  });
});

describe("invariant: only the exhausted ladder suspends a live subscription", () => {
  it("leaves an active subscription active through every engine step the owner did not ask for", () => {
    const subscription = makeSubscription({ nextCycleAt: firstCycleAt });
    const steps: EngineSubscription[] = [
      unwrap(skipNextCycle({ subscription, now })).subscription,
      unwrap(slideNextCycle({ subscription, now, newNextCycleAt: "2026-06-20T10:00:00.000Z" })).subscription,
      unwrap(swapTemplateLine({
        subscription,
        fromVariantId: secondaryVariantId,
        toVariantId: replacementVariantId,
        now,
      })).subscription,
      unwrap(addPermanentAddon({ subscription, line: { variant_id: addonVariantId, qty: 1 }, now })).subscription,
      unwrap(recordPaymentSuccess({ subscription, cycle: plannedCycle(subscription), paidAt: failedAt, recordedAt: failedAt }))
        .subscription,
    ];
    for (const step of steps) expect(step.status).toBe("active");
  });

  it("never pauses on a refusal the ladder can still retry, nor on one a class cut short", () => {
    const subscription = makeSubscription();
    for (const cycle of [refusedCycle(1), refusedCycle(2), refusedCycle(3), refusedCycle(1, "hard_do_not_retry")]) {
      const result = pauseSubscriptionForExpiredDunning({ subscription, cycle, now: failedAt });
      expect(result.ok).toBe(false);
    }
  });

  it("a delivery or payment that arrives late only ever shifts the cycle later", () => {
    const subscription = makeSubscription({ nextCycleAt: firstCycleAt });
    const cycle = plannedCycle(subscription);
    for (const lateByDays of [0, 1, 3, 9]) {
      const paidAt = new Date(Date.parse(cycle.scheduledAt) + lateByDays * 24 * 60 * 60 * 1000).toISOString();
      const paid = unwrap(recordPaymentSuccess({ subscription, cycle, paidAt, recordedAt: paidAt }));
      expect(Date.parse(paid.subscription.nextCycleAt)).toBeGreaterThanOrEqual(Date.parse(subscription.nextCycleAt));
      expect(Date.parse(paid.subscription.nextCycleAt)).toBe(
        Date.parse(cycle.scheduledAt) + (subscription.template.cadence_days + lateByDays) * 24 * 60 * 60 * 1000,
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_TRANSITIONS,
  canTransitionSubscriptionStatus,
  cancelSubscription,
  completeSubscription,
  pauseSubscription,
  reactivateSubscription,
  resumeSubscription,
  type SubscriptionStatus,
} from "../src/subscription/index.js";
import { makeSubscription, now } from "./subscriptionFixtures.js";

// The contract this file pins: the engine's status matrix is the managed SQL
// guard `public.subscription_guard_status_transition`, restricted to the four
// statuses the engine manages. The same pairs are asserted against the guard
// itself in supabase/tests/subscription_status_transition_matrix_test.sql.
// Change one side and the other must move in the same contribution.
//
// Edges the guard also admits, outside the engine's four statuses: the
// activation flow (`pending_activation` -> `active` / `activation_failed` /
// `cancelled`) and the audited expired-checkout reopen (`cancelled` ->
// `pending_activation`). `completed` and `activation_failed` are terminal.
const MIRRORED_SQL_GUARD = "public.subscription_guard_status_transition";

const ALLOWED_PAIRS: ReadonlyArray<readonly [SubscriptionStatus, SubscriptionStatus]> = [
  ["active", "paused"],
  ["active", "cancelled"],
  ["active", "completed"],
  ["paused", "active"],
  ["paused", "cancelled"],
  // Win-back: the owner reactivates a cancelled subscription.
  ["cancelled", "active"],
];

const allPairs = SUBSCRIPTION_STATUSES.flatMap((from) =>
  SUBSCRIPTION_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
);
const isAllowed = (from: SubscriptionStatus, to: SubscriptionStatus) =>
  ALLOWED_PAIRS.some(([f, t]) => f === from && t === to);

describe(`subscription status matrix mirrors ${MIRRORED_SQL_GUARD}`, () => {
  it("enumerates every ordered pair of the four engine statuses", () => {
    expect(allPairs).toHaveLength(12);
  });

  it.each(allPairs)("%s -> %s", (from, to) => {
    expect(canTransitionSubscriptionStatus(from, to)).toBe(isAllowed(from, to));
  });

  it("publishes exactly the allowed pairs and nothing else", () => {
    const published = SUBSCRIPTION_STATUSES.flatMap((from) =>
      SUBSCRIPTION_STATUS_TRANSITIONS[from].map((to) => [from, to] as const),
    );
    expect(published).toEqual(ALLOWED_PAIRS);
  });

  it("keeps completed terminal", () => {
    expect(SUBSCRIPTION_STATUS_TRANSITIONS.completed).toEqual([]);
  });

  it("is frozen, so a caller cannot widen the shipped matrix in place", () => {
    expect(Object.isFrozen(SUBSCRIPTION_STATUS_TRANSITIONS)).toBe(true);
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(Object.isFrozen(SUBSCRIPTION_STATUS_TRANSITIONS[status])).toBe(true);
    }
  });

  it("answers false for a status outside the engine vocabulary", () => {
    expect(canTransitionSubscriptionStatus("pending_activation" as SubscriptionStatus, "active")).toBe(false);
  });
});

describe("each operation takes only its own edges of the matrix", () => {
  const operations = {
    pause: (status: SubscriptionStatus) => pauseSubscription({ subscription: makeSubscription({ status }), now }),
    resume: (status: SubscriptionStatus) => resumeSubscription({ subscription: makeSubscription({ status }), now }),
    cancel: (status: SubscriptionStatus) => cancelSubscription({ subscription: makeSubscription({ status }), now }),
    complete: (status: SubscriptionStatus) => completeSubscription({ subscription: makeSubscription({ status }), now }),
    reactivate: (status: SubscriptionStatus) => reactivateSubscription({ subscription: makeSubscription({ status }), now }),
  };
  const accepts: Record<keyof typeof operations, readonly SubscriptionStatus[]> = {
    pause: ["active"],
    resume: ["paused"],
    cancel: ["active", "paused"],
    complete: ["active"],
    reactivate: ["cancelled"],
  };

  for (const [name, run] of Object.entries(operations) as Array<[keyof typeof operations, (s: SubscriptionStatus) => ReturnType<typeof pauseSubscription>]>) {
    it.each(SUBSCRIPTION_STATUSES)(`${name} from %s`, (status) => {
      const result = run(status);
      if (accepts[name].includes(status)) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
      }
    });
  }
});

describe("win-back reactivation", () => {
  it("re-arms a stale schedule two days out and records the win-back", () => {
    const cancelled = makeSubscription({ status: "cancelled", nextCycleAt: "2026-05-01T10:00:00.000Z" });
    const result = reactivateSubscription({ subscription: cancelled, now, reason: "customer_request" });
    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    expect(result.value.subscription).toMatchObject({
      status: "active",
      nextCycleAt: "2026-06-06T10:00:00.000Z",
      updatedAt: now,
    });
    expect(result.value.events.map((event) => event.eventType)).toEqual([
      "subscription.resumed",
      "subscription.next_cycle_at_updated",
    ]);
    expect(result.value.events[0]?.payload).toMatchObject({
      reactivatedFrom: "cancelled",
      reason: "customer_request",
      nextCycleAt: "2026-06-06T10:00:00.000Z",
    });
  });

  it("never pulls a stored future cycle earlier", () => {
    const cancelled = makeSubscription({ status: "cancelled", nextCycleAt: "2026-06-20T10:00:00.000Z" });
    const result = reactivateSubscription({ subscription: cancelled, now });
    expect(result.ok && result.value.subscription.nextCycleAt).toBe("2026-06-20T10:00:00.000Z");
    expect(result.ok && result.value.events.map((event) => event.eventType)).toEqual(["subscription.resumed"]);
  });

  it("refuses without a stored payment method, because a win-back charges again", () => {
    expect(reactivateSubscription({
      subscription: makeSubscription({ status: "cancelled", paymentMethodRef: null }),
      now,
    })).toMatchObject({ ok: false, error: { code: "missing_payment_method" } });
  });

  it("refuses an unreadable clock", () => {
    expect(reactivateSubscription({ subscription: makeSubscription({ status: "cancelled" }), now: "not-a-date" }))
      .toMatchObject({ ok: false, error: { code: "invalid_timestamp" } });
  });

  it("refuses a restart past the representable timestamp range", () => {
    expect(reactivateSubscription({
      subscription: makeSubscription({ status: "cancelled" }),
      now: "+275760-09-12T00:00:00.000Z",
    })).toMatchObject({ ok: false, error: { code: "invalid_timestamp" } });
  });
});

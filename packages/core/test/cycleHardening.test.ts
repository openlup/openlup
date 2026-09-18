import { describe, expect, it } from "vitest";
import {
  DEFAULT_CYCLE_RETRY_CADENCE,
  ladderTerminatedByClass,
  maxRetryAttempts,
  nextRetryAttemptAt,
  shouldScheduleRetry,
} from "../src/subscription/index.js";
import { PAYMENT_FAILURE_CLASSES, failureClassDecision } from "../src/payment/index.js";

describe("cycle hardening", () => {
  it.each([[1, "2026-06-04T12:00:00.000Z"], [2, "2026-06-06T12:00:00.000Z"], [3, "2026-06-10T12:00:00.000Z"]])(
    "maps retry %i to the configured backoff",
    (attempt, expected) => expect(nextRetryAttemptAt("2026-06-03T12:00:00.000Z", attempt)).toBe(expected),
  );

  it("terminates past the ladder end and rejects invalid inputs", () => {
    // TERMINATING, not capping: past the last slot there is no next charge, and
    // `null` is the signal the subscription pauses on. Repeating the final slot
    // forever is what let a caller believe a fourth retry was scheduled.
    expect(nextRetryAttemptAt("2026-06-03T12:00:00.000Z", 4)).toBeNull();
    expect(nextRetryAttemptAt("2026-06-03T12:00:00.000Z", 9)).toBeNull();
    expect(nextRetryAttemptAt("2026-06-03T12:00:00.000Z", 0)).toBeNull();
    expect(nextRetryAttemptAt("not-a-date", 1)).toBeNull();
  });

  it("schedules only failed cycles within the retry budget", () => {
    expect(shouldScheduleRetry("payment_failed", 1)).toBe(true);
    expect(shouldScheduleRetry("planned", 1)).toBe(false);
    expect(shouldScheduleRetry("payment_failed", 0)).toBe(false);
    expect(shouldScheduleRetry("payment_failed", maxRetryAttempts() + 1)).toBe(false);
    expect(maxRetryAttempts()).toBe(3);
  });

  it("takes an injected cadence and ships an immutable default", () => {
    const cadence = { backoffHours: [1, 2] } as const;
    expect(nextRetryAttemptAt("2026-06-03T12:00:00.000Z", 1, cadence)).toBe("2026-06-03T13:00:00.000Z");
    expect(nextRetryAttemptAt("2026-06-03T12:00:00.000Z", 3, cadence)).toBeNull();
    expect(maxRetryAttempts(cadence)).toBe(2);
    expect(shouldScheduleRetry("payment_failed", 3, cadence)).toBe(false);

    expect(DEFAULT_CYCLE_RETRY_CADENCE.backoffHours).toEqual([24, 72, 168]);
    expect(Object.isFrozen(DEFAULT_CYCLE_RETRY_CADENCE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CYCLE_RETRY_CADENCE.backoffHours)).toBe(true);
  });
});

describe("the reason for a refusal, not only the rung it reached", () => {
  const FAILED_AT = "2026-06-03T12:00:00.000Z";

  it("ships exactly ONE terminating class, and every other class keeps its ladder", () => {
    // The set was empty while the seam was being threaded; W9 filled it with the
    // single class whose meaning is that the issuer refused the instrument. The
    // list is asserted exactly rather than by membership, so a second class
    // cannot be added here without this line moving.
    expect(DEFAULT_CYCLE_RETRY_CADENCE.terminatingFailureClasses).toEqual(["hard_do_not_retry"]);
    expect(Object.isFrozen(DEFAULT_CYCLE_RETRY_CADENCE.terminatingFailureClasses)).toBe(true);
    for (const failureClass of PAYMENT_FAILURE_CLASSES) {
      if (failureClass === "hard_do_not_retry") continue;
      expect(ladderTerminatedByClass(failureClass)).toBe(false);
      for (const attempt of [1, 2, 3, 4]) {
        expect(nextRetryAttemptAt(FAILED_AT, attempt, DEFAULT_CYCLE_RETRY_CADENCE, failureClass))
          .toBe(nextRetryAttemptAt(FAILED_AT, attempt));
        expect(shouldScheduleRetry("payment_failed", attempt, DEFAULT_CYCLE_RETRY_CADENCE, failureClass))
          .toBe(shouldScheduleRetry("payment_failed", attempt));
      }
    }
  });

  it("gives the one listed class no rung at any attempt", () => {
    // The other half of the assertion above: the skip in that loop is a claim,
    // and this is where it is paid for. Every rung, not only the first, because
    // a refusal can arrive at any point in a ladder already under way.
    expect(ladderTerminatedByClass("hard_do_not_retry")).toBe(true);
    for (const attempt of [1, 2, 3, 4]) {
      expect(nextRetryAttemptAt(FAILED_AT, attempt, DEFAULT_CYCLE_RETRY_CADENCE, "hard_do_not_retry"))
        .toBeNull();
      expect(shouldScheduleRetry("payment_failed", attempt, DEFAULT_CYCLE_RETRY_CADENCE, "hard_do_not_retry"))
        .toBe(false);
    }
  });

  it("fails open on an absent, empty or unrecognised class", () => {
    for (const failureClass of [null, undefined, "", "not_a_class_at_all"]) {
      expect(ladderTerminatedByClass(failureClass)).toBe(false);
      expect(nextRetryAttemptAt(FAILED_AT, 1, DEFAULT_CYCLE_RETRY_CADENCE, failureClass))
        .toBe(nextRetryAttemptAt(FAILED_AT, 1));
    }
  });

  it("leaves a cadence that omits the field on the ladder it always had", () => {
    // An adopter's cadence written before this field existed, and the shape the
    // suite above already injects.
    const cadence = { backoffHours: [1, 2] } as const;
    expect(ladderTerminatedByClass("hard_do_not_retry", cadence)).toBe(false);
    expect(nextRetryAttemptAt(FAILED_AT, 1, cadence, "hard_do_not_retry"))
      .toBe("2026-06-03T13:00:00.000Z");
  });

  it("terminates a listed class the decision table refuses, at every rung", () => {
    // Proven against a LOCAL cadence, never the shipped one, so this assertion
    // states the mechanism and not the current membership of the shipped set.
    const cadence = {
      ...DEFAULT_CYCLE_RETRY_CADENCE,
      terminatingFailureClasses: ["hard_do_not_retry"],
    };
    expect(failureClassDecision("hard_do_not_retry").retryAllowed).toBe(false);
    for (const attempt of [1, 2, 3, 4]) {
      expect(nextRetryAttemptAt(FAILED_AT, attempt, cadence, "hard_do_not_retry")).toBeNull();
    }
    expect(shouldScheduleRetry("payment_failed", 1, cadence, "hard_do_not_retry")).toBe(false);
    expect(shouldScheduleRetry("payment_failed", 1, cadence, "soft_retryable")).toBe(true);
    expect(nextRetryAttemptAt(FAILED_AT, 1, cadence, "soft_retryable")).toBe("2026-06-04T12:00:00.000Z");
  });

  it("refuses to terminate on a listed class the decision table still permits", () => {
    // The list is configuration; the decision table is the kernel's ruling on
    // whether the instrument may be charged again. A disagreement resolves to
    // the ladder, never to a withheld charge.
    const cadence = {
      ...DEFAULT_CYCLE_RETRY_CADENCE,
      terminatingFailureClasses: ["soft_retryable", "typo_not_a_class"],
    };
    expect(failureClassDecision("soft_retryable").retryAllowed).toBe(true);
    expect(ladderTerminatedByClass("soft_retryable", cadence)).toBe(false);
    expect(ladderTerminatedByClass("typo_not_a_class", cadence)).toBe(false);
  });
});

/**
 * Subscription cycle hardening helpers — the canonical retry ladder a renewal
 * payment failure follows.
 *
 * This module is the SINGLE authority on the ladder. It answers three questions:
 *
 *   - `nextRetryAttemptAt(failedAt, attemptNumber, cadence?, failureClass?)` —
 *     when the next charge is due, or `null` when no next charge is due.
 *   - `shouldScheduleRetry(cycleStatus, attemptNumber, cadence?, failureClass?)`
 *     — whether a failed payment may move into `retry_scheduled`.
 *   - `ladderTerminatedByClass(failureClass, cadence?)` — whether the REASON for
 *     the refusal, rather than the rung reached, ends the ladder.
 *
 * TERMINATING, not capping. An attempt past the end of the ladder answers
 * `null`, which is the pause signal; it does not answer "the last slot again".
 * Callers therefore never need a `attempt <= maxRetryAttempts()` guard of their
 * own — asking for the next slot IS the decision, and a second copy of the
 * budget check is exactly how two rails drift apart.
 *
 * The cadence is injectable so a deployment can publish its own ladder, and the
 * default is frozen so nobody can mutate the shipped one in place.
 *
 * All helpers are PURE — they never schedule local jobs, never touch payment
 * adapters, never persist a cycle.
 */

import {
  PAYMENT_FAILURE_CLASSES,
  failureClassDecision,
  type PaymentFailureClass,
} from "../payment/paymentFailureTaxonomyContracts.js";

/** @beta */
export interface CycleRetryCadence {
  /**
   * Hours after the failure at which each successive retry is due, in order.
   * Its length IS the retry budget: `maxRetryAttempts()` reports it and
   * `nextRetryAttemptAt` terminates past it.
   */
  readonly backoffHours: readonly number[];
  /**
   * Refusal classes for which this deployment publishes no ladder at all, named
   * as {@link PaymentFailureClass} values. Typed as strings because the same set
   * is read back out of a nullable `text` column written by an older deployment,
   * and an unrecognised value must be ignored rather than crash a schedule.
   *
   * Omitting it means "no class ends the ladder early", which is the behaviour
   * every deployment had before this field existed.
   */
  readonly terminatingFailureClasses?: readonly string[];
}

/** @beta */
export const DEFAULT_CYCLE_RETRY_CADENCE: CycleRetryCadence = Object.freeze({
  backoffHours: Object.freeze([24, 72, 168]) as readonly number[], // 1d, 3d, 7d
  // ONE member. `hard_do_not_retry` is the taxonomy's statement that the issuer
  // refused the INSTRUMENT rather than this charge, so no rung below can change
  // the answer and three more attempts only promise the customer eleven days of
  // charges that cannot land. Every other class keeps the full cadence. Its SQL
  // twin is `v_terminating_classes` in the canonical apply body;
  // scripts/retry-ladder-terminating-classes.test.ts reads that literal out of
  // the latest declaring migration and fails if the two sets ever differ.
  terminatingFailureClasses: Object.freeze(["hard_do_not_retry"]) as readonly string[],
});

/** @beta */
export type CycleHandlerStatus =
  | "planned"
  | "payment_pending"
  | "paid"
  | "payment_failed"
  | "retry_scheduled"
  | "skipped"
  | "cancelled";

/**
 * Whether the class of a refusal, rather than the rung it reached, ends the
 * ladder.
 *
 * Fails OPEN in three separate ways, because a wrong `true` here withholds a
 * charge the customer expected while a wrong `false` merely retries as before:
 * an absent class does not terminate, a class the cadence does not list does not
 * terminate, and a listed class the taxonomy does not recognise does not
 * terminate. The last check is why a typo in configuration cannot stop a ladder.
 *
 * The final word belongs to {@link failureClassDecision}, not to the list: a
 * cadence that lists a class the decision table still permits retrying is
 * incoherent, and the table wins. That keeps the schedule from ever contradicting
 * the kernel that already ruled on whether the instrument may be charged again.
 *
 * @beta
 */
export function ladderTerminatedByClass(
  failureClass: string | null | undefined,
  cadence: CycleRetryCadence = DEFAULT_CYCLE_RETRY_CADENCE,
): boolean {
  if (failureClass === null || failureClass === undefined) return false;
  if (!(cadence.terminatingFailureClasses ?? []).includes(failureClass)) return false;
  if (!(PAYMENT_FAILURE_CLASSES as readonly string[]).includes(failureClass)) return false;
  return !failureClassDecision(failureClass as PaymentFailureClass).retryAllowed;
}

/** @beta */
export function nextRetryAttemptAt(
  failedAtIso: string,
  attemptNumber: number,
  cadence: CycleRetryCadence = DEFAULT_CYCLE_RETRY_CADENCE,
  failureClass?: string | null,
): string | null {
  if (ladderTerminatedByClass(failureClass, cadence)) return null;
  const hours = cadence.backoffHours[attemptNumber - 1];
  // Covers both ends at once: an attempt below 1 and an attempt past the last
  // ladder slot are equally "no next charge is due".
  if (attemptNumber < 1 || hours === undefined) return null;
  const failedAt = new Date(failedAtIso);
  if (Number.isNaN(failedAt.getTime())) return null;
  const next = new Date(failedAt.getTime() + hours * 60 * 60 * 1000);
  return next.toISOString();
}

/** @beta */
export function shouldScheduleRetry(
  cycleStatus: CycleHandlerStatus,
  attemptNumber: number,
  cadence: CycleRetryCadence = DEFAULT_CYCLE_RETRY_CADENCE,
  failureClass?: string | null,
): boolean {
  if (cycleStatus !== "payment_failed") return false;
  if (attemptNumber < 1) return false;
  // Asked and answered by the same predicate the schedule uses, so this helper
  // cannot say "schedule one" about a refusal for which the ladder answers none.
  if (ladderTerminatedByClass(failureClass, cadence)) return false;
  return attemptNumber <= maxRetryAttempts(cadence);
}

/** @beta */
export function maxRetryAttempts(
  cadence: CycleRetryCadence = DEFAULT_CYCLE_RETRY_CADENCE,
): number {
  return cadence.backoffHours.length;
}

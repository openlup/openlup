/**
 * Neutral payment-method lifecycle vocabulary.
 *
 * A stored consent does not only come into existence. It is rotated, revoked
 * and suspended, and it expires — and every rail announces those transitions in
 * its own words. This module is the vocabulary those announcements are
 * translated INTO, so the engine that reacts (deactivating a dead method,
 * warning a payer before a renewal that can no longer be charged) never has to
 * learn a rail's event names.
 *
 * Types and pure functions only: nothing here reads a clock, a network or a
 * database, and no rail is named.
 */

/**
 * Every transition a rail may report about a method it holds on file.
 *
 * `method_suspended` is declared but published by no rail in this deployment.
 * It is here because the consuming branch is exhaustive over this list: a rail
 * that starts emitting a suspension must be handled, never silently ignored.
 */
export const PAYMENT_METHOD_LIFECYCLE_EVENT_KINDS = [
  "method_registered",
  "method_updated",
  "method_revoked",
  "method_expired",
  "method_suspended",
] as const;

export type PaymentMethodLifecycleEventKind =
  (typeof PAYMENT_METHOD_LIFECYCLE_EVENT_KINDS)[number];

/**
 * What the rail reports about the method AFTER the transition.
 *
 * Deliberately three fields and no more: the label a payer recognises the
 * method by, the trailing digits shown beside it, and the instant it stops
 * being chargeable. ⛔ The full instrument number is never part of this
 * contract, and an adapter that put one here would be widening a surface this
 * type exists to keep narrow.
 *
 * Every field is independently nullable because rails report them
 * independently: an alias rail may carry an expiry and no digits at all.
 */
export interface PaymentMethodReplacementFacts {
  /** Scheme or rail label the payer recognises, e.g. a card network name. */
  schemeLabel: string | null;
  /** Trailing digits of the instrument, never more than the payer is shown. */
  lastDigits: string | null;
  /** ISO-8601 instant after which the method can no longer be charged. */
  expiresAt: string | null;
}

/**
 * One rail transition, expressed neutrally.
 *
 * `providerKind` and `providerMethodRef` are opaque identity, not a branch
 * condition: together they address exactly one stored method. A consumer that
 * compares `providerKind` against a known name re-creates the coupling this
 * contract removes.
 */
export interface PaymentMethodLifecycleEvent {
  kind: PaymentMethodLifecycleEventKind;
  /** Registry key of the rail that reported this, used only for addressing. */
  providerKind: string;
  /** The rail's own reference for the stored method this transition is about. */
  providerMethodRef: string;
  /** The rail's identifier for this delivery, used for replay-safe writes. */
  providerEventId: string;
  /** ISO-8601 instant the rail reported the transition at. */
  occurredAt: string;
  /** Fresh facts the rail published with the transition, when it published any. */
  replacement?: PaymentMethodReplacementFacts | null;
}

/**
 * Whether this transition means the stored method can no longer back a charge.
 *
 * The single place that answers it. ⛔ A rotation (`method_updated`) is NOT a
 * death: the same consent continues under fresh details, and treating it as one
 * would strip a healthy subscription of the method it renews on.
 */
export function endsStoredMethodUsability(
  kind: PaymentMethodLifecycleEventKind,
): boolean {
  return kind === "method_revoked" || kind === "method_expired" || kind === "method_suspended";
}

export function isPaymentMethodLifecycleEventKind(
  value: unknown,
): value is PaymentMethodLifecycleEventKind {
  return typeof value === "string"
    && (PAYMENT_METHOD_LIFECYCLE_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * The instant a month-and-year validity actually runs out.
 *
 * Convention, pinned here once so no adapter has to re-decide it: an
 * instrument valid "through 06/2027" is chargeable for the whole of that month
 * and stops at the LAST instant of it, in UTC — `2027-06-30T23:59:59.999Z`. The
 * common alternative, the first instant of the month, would retire a method up
 * to 31 days before the payer's own statement says it dies.
 *
 * UTC rather than a local zone on purpose: the value is compared against
 * `now()` by storage and by health reads, both of which are UTC, and the
 * one-day ambiguity a local zone would introduce is not worth a timezone
 * dependency in a kernel.
 *
 * Returns null for anything that is not a plainly valid month and four-digit
 * year, so a malformed rail payload yields "no expiry known" rather than a
 * fabricated date.
 */
export function expiryInstantFromMonthYear(
  month: number | null | undefined,
  year: number | null | undefined,
): string | null {
  if (!Number.isInteger(month) || !Number.isInteger(year)) return null;
  const monthValue = month as number;
  const yearValue = year as number;
  if (monthValue < 1 || monthValue > 12) return null;
  // Below 1000 the platform's own two-digit-year remapping would silently turn
  // 27 into 1927; a rail that abbreviates the year is refused, not guessed at.
  if (yearValue < 1000 || yearValue > 9999) return null;
  // Month is 1-based here and 0-based in the platform date constructor, so
  // passing it unchanged addresses the FIRST instant of the following month;
  // one millisecond earlier is the last instant of the expiry month itself.
  const firstInstantAfter = Date.UTC(yearValue, monthValue, 1);
  return new Date(firstInstantAfter - 1).toISOString();
}

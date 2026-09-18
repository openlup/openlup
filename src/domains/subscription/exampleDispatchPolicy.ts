import type { DeliveryDispatchPolicy } from "./deliveryEstimate.js";

/**
 * Public/default owner of `#delivery-dispatch-policy`: the Example Store's
 * fulfilment timetable.
 *
 * This is the value a fresh installation runs on, and it is deliberately the
 * most boring timetable that is still a real one — a deployment that never
 * edits it still gets correct, explainable delivery windows rather than an
 * error or a placeholder. Every field is chosen so that no reader has to know
 * where the Example Store is:
 *
 * - `UTC` — the one zone that is nobody's local time and needs no tz database
 *   nuance to reason about.
 * - a Monday-to-Friday week, because that is the assumption the estimator's own
 *   `businessDays` contract is written against.
 * - an EMPTY holiday list, which is a statement rather than an omission: the
 *   platform ships no jurisdiction's calendar. `DeliveryDispatchPolicy.holidays`
 *   is required and without a default precisely so that a deployment with no
 *   such days has to say `[]` out loud. An adopter adds its own calendar in its
 *   own overlay, next to this file rather than inside it.
 * - one-to-two working days of transit, the shortest window that still exercises
 *   the min/max branch of the estimator instead of collapsing it.
 *
 * ⛔ Do not add a jurisdiction, an operator or a market to this file. The moment
 * it names one it stops being the neutral default and becomes somebody's
 * overlay; that is what `#delivery-dispatch-policy`'s private side is for.
 */
export const DELIVERY_DISPATCH_POLICY: DeliveryDispatchPolicy = {
  timeZone: "UTC",
  cutoffHour: 16,
  businessDays: [1, 2, 3, 4, 5],
  holidays: [],
  minTransitBusinessDays: 1,
  maxTransitBusinessDays: 2,
};

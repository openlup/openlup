/**
 * The plan lengths, in days, a subscription may be built around.
 *
 * A neutral table: three cadences that divide evenly into weeks, so a delivery
 * always lands on the same weekday the previous one did. Every surface that
 * offers a plan length — the composer's length step, the recommendation sizing,
 * the account's package editor — reads this one list, so adding or retiring a
 * cadence is a single edit rather than a search.
 *
 * ⛔ Order is load-bearing: `[0]` is the default cadence a surface falls back to
 * when no recommendation has resolved yet.
 */
export const BUNDLE_LENGTHS = [14, 21, 28] as const;

export type BundleLengthDays = (typeof BUNDLE_LENGTHS)[number];

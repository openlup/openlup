import { z } from "../../lib/validation/zod.js";

// The dunning recovery baseline: how much of the money that fell into dunning
// came back, and which slices of the window it came back from.
//
// Telemetry only. Nothing branches on this read-model - no alert threshold, no
// evaluator input, no customer-visible behavior. It exists so the recovery
// programme has one number that means the same thing every time it is quoted,
// with its denominator written down next to it.
//
// The shape is declared here rather than beside the query that fills it, because
// it crosses the wire: the adapter produces exactly this type and the compiler
// checks that seam, so the projection and the contract cannot drift apart.

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const dunningRecoveryCohortSchema = z.object({
  count: z.number().int().nonnegative(),
  /** Summed in the smallest currency unit. `0` when no case in the cohort resolved an amount. */
  amountMinor: z.number().int(),
}).strict();

/**
 * One slice of the window: what it opened, what came back, and the rate between
 * them. The denominator is everything the slice OPENED, so still-open cases
 * depress the rate rather than being excluded from it -- the same conservative
 * choice the window-wide rate makes, kept identical here so a per-slice rate can
 * be read against the headline figure without a footnote.
 */
export const dunningRecoveryDimensionSchema = z.object({
  opened: dunningRecoveryCohortSchema,
  recovered: dunningRecoveryCohortSchema,
  recoveryRateByCount: z.number().nullable(),
  recoveryRateByAmount: z.number().nullable(),
}).strict();

/**
 * A breakdown is keyed by what the database returned, never by a list declared
 * here. A retry rung is an integer the ladder can lengthen; a failure class comes
 * from a taxonomy a migration owns; a payment rail is whichever providers this
 * deployment happens to run. Enumerating any of the three would put a
 * deployment's vendor inventory into a portable contract and make every new
 * value a code change.
 */
const dunningRecoveryBreakdownSchema = z.record(z.string(), dunningRecoveryDimensionSchema);

export const dunningRecoveryBaselineSchema = z.object({
  /** Inclusive lower bound on `opened_at`. */
  windowStart: isoDateTimeSchema,
  /** The injected `now`; cases are never counted past it. */
  windowEnd: isoDateTimeSchema,
  windowDays: z.number().int().min(1),
  /**
   * True when the case read returned exactly its row cap, i.e. the window may
   * hold more cases than were measured. Every figure below is then a floor.
   */
  truncated: z.boolean(),
  /** The single currency every amount is expressed in, or `null` when the window mixed currencies or resolved none. */
  currency: z.string().trim().min(1).max(8).nullable(),
  mixedCurrencies: z.boolean(),
  /** Cases whose amount could not be resolved; they count in every `count`, and in no `amountMinor`. */
  amountsMissing: z.number().int().nonnegative(),
  /** Every case opened inside the window. This is the denominator of both rates. */
  opened: dunningRecoveryCohortSchema,
  recovered: dunningRecoveryCohortSchema,
  expired: dunningRecoveryCohortSchema,
  /**
   * Cases closed because the subscription was cancelled while dunning was still
   * open. A non-recovery outcome, counted against the rate like an expiry:
   * money that entered dunning and did not come back.
   */
  cancelled: dunningRecoveryCohortSchema,
  /**
   * Cases closed because the customer resumed a subscription whose dunning
   * journey had already expired. The subscription came back; the money did not.
   * The failed cycle is skipped rather than collected, so this is a non-recovery
   * outcome counted against the rate like an expiry -- which is exactly why the
   * rail closes such a case as `resumed_unpaid` instead of reusing `recovered`.
   */
  resumedUnpaid: dunningRecoveryCohortSchema,
  /**
   * Cases opened inside the window that are still open at `windowEnd`. Never
   * folded into a rate silently: they are counted against recovery in the
   * denominator and reported here on their own. A case in an unrecognised status
   * lands here too, so an unknown status can only depress the rate, never
   * inflate it.
   */
  stillOpen: dunningRecoveryCohortSchema,
  /**
   * How a recovered case was closed, read from case metadata written by the two
   * writers that close cases today. `unattributed` is a real answer, not an
   * error: older cases predate attribution.
   */
  recoveredByAttribution: z.object({
    automaticRetry: dunningRecoveryCohortSchema,
    customerRedeem: dunningRecoveryCohortSchema,
    unattributed: dunningRecoveryCohortSchema,
  }).strict(),
  /**
   * Recovered cases divided by every case OPENED inside the window - that is,
   * recovered + expired + cancelled + resumed-unpaid + still-open. Cancelled
   * cases, resumed-unpaid cases and cases still open at `windowEnd` all count
   * AGAINST the rate, so this is a conservative floor and never a partial-cohort
   * rate. Cases opened before `windowStart` are excluded even if they resolved
   * inside it. `null` when the window opened no case.
   */
  recoveryRateByCount: z.number().nullable(),
  /**
   * Same denominator as `recoveryRateByCount`, in money. `null` when the window
   * resolved no amount or mixed currencies, because a ratio of sums across
   * currencies is not a rate.
   */
  recoveryRateByAmount: z.number().nullable(),
  /** Keyed by retry attempt rendered as a decimal string. */
  byRung: dunningRecoveryBreakdownSchema,
  /**
   * Keyed by the class stamped on the case when it opened. Cases opened before
   * that column existed carry none and land under a single unclassified key, so
   * the epoch is visible in the data instead of silently shrinking a denominator.
   */
  byClass: dunningRecoveryBreakdownSchema,
  /** Keyed by the rail the failed payment was attempted on. */
  byRail: dunningRecoveryBreakdownSchema,
}).strict();

export type DunningRecoveryBaselineProjection = z.infer<typeof dunningRecoveryBaselineSchema>;
export type DunningRecoveryDimension = z.infer<typeof dunningRecoveryDimensionSchema>;
export type DunningRecoveryCohortProjection = z.infer<typeof dunningRecoveryCohortSchema>;

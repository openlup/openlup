import { z } from "../../lib/validation/zod.js";
import {
  STARTER_DELIVERY2_DISCOUNT_BPS,
  STARTER_INITIAL_DISCOUNT_BPS,
  STARTER_INTERVAL_MAX_DAYS,
  STARTER_INTERVAL_MIN_DAYS,
  STARTER_MAX_DAILY_GRAMS,
  STARTER_MIN_CANS,
  STARTER_OFFER_CAPABILITY,
  STARTER_STEADY_CADENCE_THRESHOLD_G_PER_DAY,
} from "./starterOfferPolicy.js";

/**
 * Wire contracts for the starter-pack acquisition offer.
 *
 * Three schemas, three different trust levels:
 *
 *  1. `starterOfferResponseSchema` — what the server TELLS a capable client
 *     about the offer. Advisory: the client uses it to render, never to price.
 *  2. `starterOfferIntentSchema` — what the client ASKS FOR at checkout. Fully
 *     untrusted: the server recomputes every field from the real basket and
 *     rejects a mismatch, exactly like a moved quote.
 *  3. `starterPackPlanSchema` — what the server FREEZES into
 *     `quote.context.starterPack` at finalize, and therefore into
 *     `subscriptions.starter_pack`. Never client-supplied.
 *
 * ⚠️ (3) is a deliberate DUPLICATE of `starterPackMarkerSchema` in
 * `server/domains/subscription/starterPackCycle.ts`. It cannot be imported:
 * `src/**` is browser-bundled and `src/lib/architectureGuardrails.test.ts`
 * blocks a commerce module from reaching into another domain's internals. The
 * two schemas are pinned to each other by `tests/starter-pack/markerParity.test.ts`,
 * which drives both over the same accept and reject fixtures. If you change one,
 * that test fails until you change the other.
 */

export const starterOfferResponseSchema = z
  .object({
    /** True only when the flag is on AND this email is first-order eligible. */
    eligible: z.boolean(),
    initialDiscountBps: z.number().int().min(0).max(10_000),
    delivery2DiscountBps: z.number().int().min(0).max(10_000),
    minCans: z.number().int().min(1),
    intervalMinDays: z.number().int().min(1),
    intervalMaxDays: z.number().int().min(1),
    steadyCadenceThresholdGramsPerDay: z.number().int().min(1),
    maxDailyGrams: z.number().int().min(1),
  })
  .strict();

export type StarterOfferResponse = z.infer<typeof starterOfferResponseSchema>;

export const starterOfferIntentSchema = z
  .object({
    capability: z.literal(STARTER_OFFER_CAPABILITY),
    intervalDays: z
      .number()
      .int()
      .min(STARTER_INTERVAL_MIN_DAYS)
      .max(STARTER_INTERVAL_MAX_DAYS),
    delivery2DiscountBps: z.number().int().min(0).max(10_000),
    steady: z
      .object({
        cadenceDays: z.union([z.literal(14), z.literal(28)]),
        cans: z.number().int().min(1),
      })
      .strict(),
  })
  .strict();

export type StarterOfferIntent = z.infer<typeof starterOfferIntentSchema>;

/**
 * The frozen acquisition plan. Mirrors `starterPackMarkerSchema` field for
 * field, including the plain (stripping, not `.strict()`) object semantics the
 * migration relies on: the RPC rebuilds the stored marker from validated fields
 * only, so an unknown key is dropped rather than rejected.
 */
export const starterPackPlanSchema = z.object({
  schemaVersion: z.literal("1"),
  starterIntervalDays: z
    .number()
    .int()
    .min(STARTER_INTERVAL_MIN_DAYS)
    .max(STARTER_INTERVAL_MAX_DAYS),
  basisTemplateVersion: z.number().int().min(1),
  delivery2: z.object({
    discountBps: z.number().int().min(0).max(10_000),
    discountMinor: z.number().int().min(0),
    basisSubtotalMinor: z.number().int().min(0),
  }),
  graduation: z.object({
    cadenceDays: z.union([z.literal(14), z.literal(28)]),
    sizeConstraint: z.record(z.string(), z.unknown()).optional(),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1),
          qty: z.number().int().min(1),
          sortOrder: z.number().int().min(0),
          isAddon: z.boolean(),
          quoteLine: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1),
  }),
})
  /**
   * Cross-field truth: a plan that PROMISES a `unit_count` basket size must ship
   * lines that add up to it.
   *
   * Without this a marker could declare `sizeConstraint.value = 28` while its
   * graduation lines sum to 29 — the graduation RPC writes both, so the
   * subscription would silently settle on a package one can larger than the one
   * the customer was quoted and agreed to, forever. The shape checks above
   * cannot see it: every individual field is valid.
   *
   * ⚠️ This makes the MINT side strictly stricter than the READ side
   * (`starterPackMarkerSchema`), which is deliberately left permissive so an
   * already-stored marker can never become unparseable and strand a live
   * subscription. The asymmetry is pinned, with this reason, in
   * `server/domains/subscription/starterPackMarkerParity.test.ts`.
   */
  .superRefine((plan, ctx) => {
    const constraint = plan.graduation.sizeConstraint;
    if (!constraint || constraint.kind !== "unit_count") return;
    const declared = constraint.value;
    if (typeof declared !== "number") return;
    const total = plan.graduation.lines.reduce((sum, line) => sum + line.qty, 0);
    if (total !== declared) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `graduation lines total ${total} cans but the size constraint promises ${declared}`,
        path: ["graduation", "lines"],
      });
    }
  });

export type StarterPackPlan = z.infer<typeof starterPackPlanSchema>;

/**
 * The one advisory payload the eligibility endpoint emits. Pure projection of
 * the policy constants, so a capable client never hard-codes them.
 */
export function starterOfferResponseFor(eligible: boolean): StarterOfferResponse {
  return {
    eligible,
    initialDiscountBps: STARTER_INITIAL_DISCOUNT_BPS,
    delivery2DiscountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
    minCans: STARTER_MIN_CANS,
    intervalMinDays: STARTER_INTERVAL_MIN_DAYS,
    intervalMaxDays: STARTER_INTERVAL_MAX_DAYS,
    steadyCadenceThresholdGramsPerDay: STARTER_STEADY_CADENCE_THRESHOLD_G_PER_DAY,
    maxDailyGrams: STARTER_MAX_DAILY_GRAMS,
  };
}

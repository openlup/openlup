import { z } from "../../lib/validation/zod.js";
import {
  catalogAllergenSlugSchema,
  catalogProductSlugSchema,
} from "../catalog/contracts.js";
import {
  COMMERCE_RECOMMENDATION_REASON_CODES,
  COMMERCE_RECOMMENDATION_STATUSES,
} from "./recommendationConstants.js";
import {
  COMMERCE_RECOMMENDATION_VERSION,
} from "./recommendationEngine.js";
import { commerceOfferAvailabilityStatusSchema } from "./offerAvailabilityContracts.js";

export const COMMERCE_RECOMMENDATION_CONTRACT_VERSION =
  "commerce.recommendation.v2";

// Open value space — format-validated slugs, not closed enums (see slugFormat.ts).
const allergenSlugSchema = catalogAllergenSlugSchema;
const productSlugSchema = catalogProductSlugSchema;
const recommendationStatusSchema = z.enum(COMMERCE_RECOMMENDATION_STATUSES);
const recommendationReasonCodeSchema = z.enum(COMMERCE_RECOMMENDATION_REASON_CODES);
const recommendationPolicyVersionSchema = z.string().trim().min(1).max(160);
const recommendationPolicySourceSchema = z.string().trim().min(1).max(120);

export const commerceRecommendationRequestSchema = z
  .object({
    petProfile: z
      .object({
        ageBand: z.enum(["puppy", "young", "adult", "senior"]),
        weightKg: z.number().positive().max(120),
        activityLevel: z.enum(["low", "normal", "high"]).optional(),
        bcs: z.enum(["thin", "ideal", "overweight"]).optional(),
        allergenSlugs: z.array(allergenSlugSchema).max(20).default([]),
        dailyKcalOverride: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    selectedFlavorSlugs: z.array(productSlugSchema).min(1).max(12).optional(),
    selectedVariantIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    allowedVariantIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    desiredSizeKind: z.enum(["unit_count", "total_weight_g", "feeding_days"]),
    cadenceDays: z.number().int().positive().max(120),
    consciousAllergenOverride: z.boolean().default(false),
    /**
     * How big the package should be. Additive and OPTIONAL rather than defaulted:
     * omitting it must leave the request byte-identical to a pre-starter-pack one,
     * because that payload is also the client's recommendation cache key. Absent
     * means `cadence_target`.
     *
     * `minimum_order` asks for the smallest sellable basket at the SAME cadence
     * — the starter pack. The cadence is kept honest rather than faked down: the
     * response then reports how few days the smaller package really covers.
     */
    sizePolicy: z.enum(["cadence_target", "minimum_order"]).optional(),
  })
  .strict();

const recommendationLineSchema = z
  .object({
    variantId: z.string().trim().min(1),
    sku: z.string().trim().min(1),
    slug: productSlugSchema,
    qty: z.number().int().positive(),
    netWeightG: z.number().int().positive(),
    kcalPerUnit: z.number().positive(),
    allergenSlugs: z.array(allergenSlugSchema),
    purchaseAvailability: commerceOfferAvailabilityStatusSchema.optional(),
    // Internal stock-enforcement passthrough — the sellable-now cap used to bound
    // the mix editor's "+". Never rendered as a number. Optional/nullable so the
    // static path and legacy snapshots stay valid (additive contract change).
    sellableNow: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

const allergenConflictSchema = z
  .object({
    variantId: z.string().trim().min(1),
    sku: z.string().trim().min(1),
    allergenSlugs: z.array(allergenSlugSchema),
  })
  .strict();

const excludedProductSchema = allergenConflictSchema
  .extend({
    slug: productSlugSchema,
    reason: z.literal("allergen_conflict"),
  })
  .strict();

const suggestedVariantSchema = z
  .object({
    variantId: z.string().trim().min(1),
    sku: z.string().trim().min(1),
    slug: productSlugSchema,
    purchaseAvailability: commerceOfferAvailabilityStatusSchema.optional(),
    sellableNow: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const commerceRecommendationSnapshotSchema = z
  .object({
    version: z.literal(COMMERCE_RECOMMENDATION_VERSION),
    status: recommendationStatusSchema,
    reasonCodes: z.array(recommendationReasonCodeSchema),
    energy: z
      .object({
        policyVersion: recommendationPolicyVersionSchema,
        source: recommendationPolicySourceSchema,
        ageBand: z.enum(["puppy", "young", "adult", "senior"]),
        activityLevel: z.enum(["low", "normal", "high"]),
        bcs: z.enum(["thin", "ideal", "overweight"]),
        kcalPerKgBodyWeight075: z.number().nonnegative().nullable(),
        dailyKcal: z.number().int().positive().nullable(),
        dailyGrams: z.number().int().positive().nullable(),
      })
      .strict(),
    dailyKcal: z.number().int().positive().nullable(),
    dailyGrams: z.number().int().positive().nullable(),
    totalWeightG: z.number().int().nonnegative(),
    feedingDays: z.number().positive().nullable(),
    desiredSizeKind: z.enum(["unit_count", "total_weight_g", "feeding_days"]),
    cadenceDays: z.number().int().positive(),
    lines: z.array(recommendationLineSchema).max(50),
    allergenConflicts: z.array(allergenConflictSchema),
    excludedProducts: z.array(excludedProductSchema),
    // Additive/backwards-compatible: safe alternatives remain suggestions until
    // the customer explicitly adds one to selectedVariantIds.
    suggestedVariants: z.array(suggestedVariantSchema).max(50).optional(),
    allergenOverrideRecorded: z.boolean(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.status !== "manual_review" && snapshot.lines.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "buyable recommendation requires at least one line",
        path: ["lines"],
      });
    }
  });

export const commerceRecommendationResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_RECOMMENDATION_CONTRACT_VERSION),
    recommendation: commerceRecommendationSnapshotSchema,
  })
  .strict();

// Batch variant: build several recommendation snapshots (e.g. the configurator's
// 14/21/28-day length tiles) in one round-trip so the client stops fanning out
// one request per length. Order is preserved: `recommendations[i]` in the
// response corresponds to the i-th request.
export const commerceRecommendationBatchRequestSchema = z
  .object({
    recommendations: z.array(commerceRecommendationRequestSchema).min(1).max(8),
  })
  .strict();

export const commerceRecommendationBatchResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_RECOMMENDATION_CONTRACT_VERSION),
    recommendations: z.array(commerceRecommendationSnapshotSchema),
  })
  .strict();

export type CommerceRecommendationRequest = z.infer<typeof commerceRecommendationRequestSchema>;
export type CommerceRecommendationSnapshot = z.infer<typeof commerceRecommendationSnapshotSchema>;
export type CommerceRecommendationResponse = z.infer<typeof commerceRecommendationResponseSchema>;
export type CommerceRecommendationBatchRequest = z.infer<
  typeof commerceRecommendationBatchRequestSchema
>;
export type CommerceRecommendationBatchResponse = z.infer<
  typeof commerceRecommendationBatchResponseSchema
>;

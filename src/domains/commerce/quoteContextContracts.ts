/**
 * The quote context: what a quote was priced for, carried into the order
 * snapshot. `quoteContracts.ts` re-exports every schema here unchanged.
 */
import { z } from "../../lib/validation/zod.js";
import { catalogAllergenSlugSchema } from "../catalog/contracts.js";
import { commerceSizeConstraintSchema } from "./contractPrimitives.js";
import { pricingPolicySnapshotSchema } from "./offerPolicyContracts.js";
import { commerceOfferEvidenceSchema, commerceOfferVersionSchema } from "./offerVersionContracts.js";
import { starterPackPlanSchema } from "./starterOfferContracts.js";

export const quoteSizeConstraintSchema = commerceSizeConstraintSchema;
export const quotePetProfileContextSchema = z
  .object({
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    ageBand: z.enum(["puppy", "young", "adult", "senior"]).optional(),
    breed: z.string().trim().min(1).max(120).optional(),
    weightKg: z.number().positive().max(120).optional(),
    activityLevel: z.enum(["low", "normal", "high"]).optional(),
    bcs: z.enum(["thin", "ideal", "overweight"]).optional(),
    allergenSlugs: z.array(catalogAllergenSlugSchema).optional(),
    dailyKcalOverride: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const quoteCustomerEligibilityContextSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(320).optional(),
    visitorId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const quoteContextSchema = z
  .object({
    mode: z.enum(["one_time", "subscription"]),
    cadenceDays: z.number().int().positive().max(120).nullable().optional(),
    feedingCoverageDays: z.number().positive().nullable().optional(),
    sizeConstraint: quoteSizeConstraintSchema.optional(),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    petProfileContext: quotePetProfileContextSchema.optional(),
    pricingPolicy: pricingPolicySnapshotSchema.optional(),
    // SERVER-MINTED ONLY: injected by the checkout quote guard after pricing, never
    // accepted from a client, read by the provisional-creation RPC to seed the marker.
    starterPack: starterPackPlanSchema.optional(),
    // SERVER-MINTED ONLY, like `starterPack`: the offer version the adopter's offer
    // policy bound at checkout, and the adopter's evidence for that binding.
    offerVersion: commerceOfferVersionSchema.optional(),
    offerEvidence: commerceOfferEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((context, ctx) => {
    if (context.offerEvidence !== undefined && context.offerVersion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offerEvidence requires offerVersion",
        path: ["offerEvidence"],
      });
    }
  });

import { z } from "../../lib/validation/zod.js";

export const OFFER_POLICY_V1 = "commerce.offer-policy.v1" as const;
export const OFFER_POLICY_V2 = "commerce.offer-policy.v2" as const;
export const PROMOTION_ENGINE_V1 = "promotion-engine.v1" as const;
export const PROMOTION_ENGINE_V2 = "promotion-engine.v2" as const;
export const OFFER_POLICY_V2_CAPABILITY = OFFER_POLICY_V2;

export const offerPolicyVersionSchema = z.enum([OFFER_POLICY_V1, OFFER_POLICY_V2]);
export const promotionEngineVersionSchema = z.enum([PROMOTION_ENGINE_V1, PROMOTION_ENGINE_V2]);

/** Client capability plus an opaque server-signed assignment. Never a version selector. */
export const pricingPolicyRequestSchema = z.object({
  capability: z.literal(OFFER_POLICY_V2_CAPABILITY).optional(),
  token: z.string().trim().min(32).max(2048).optional(),
}).strict();

export const pricingPolicySnapshotSchema = z.object({
  offerPolicyVersion: offerPolicyVersionSchema,
  promotionEngineVersion: promotionEngineVersionSchema,
  pricingPolicyToken: z.string().trim().min(32).max(2048).optional(),
}).strict().refine(
  (value) =>
    (value.offerPolicyVersion === OFFER_POLICY_V1 && value.promotionEngineVersion === PROMOTION_ENGINE_V1) ||
    (value.offerPolicyVersion === OFFER_POLICY_V2 && value.promotionEngineVersion === PROMOTION_ENGINE_V2),
  { message: "offer policy and promotion engine versions must be paired" },
);

export type OfferPolicyVersion = z.infer<typeof offerPolicyVersionSchema>;
export type PromotionEngineVersion = z.infer<typeof promotionEngineVersionSchema>;
export type PricingPolicyRequest = z.infer<typeof pricingPolicyRequestSchema>;
export type PricingPolicySnapshot = z.infer<typeof pricingPolicySnapshotSchema>;

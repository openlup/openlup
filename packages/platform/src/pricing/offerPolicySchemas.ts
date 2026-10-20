import { z } from "./validation.js";
import { OFFER_POLICY_V1, OFFER_POLICY_V2, PROMOTION_ENGINE_V1, PROMOTION_ENGINE_V2, OFFER_POLICY_V2_CAPABILITY } from "./contracts/index.js";

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


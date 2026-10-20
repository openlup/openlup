
import { z } from "./validation.js";

import {
  PROMOTION_APPLIES_TO_KINDS,
  PROMOTION_DISCOUNT_TYPES,
  PROMOTION_STACKING_RULES,
  PROMOTION_TRIGGER_TYPES,
} from "@openlup/core/promo";

import { COMMERCE_CONTRACT_VERSION } from "../pricing/index.js";

/** Admin promotion schemas; raw adapter rows never cross this boundary. */


export function createAdminPromotionSchemas({ currencySchema: platformCurrencySchema }: { currencySchema: z.ZodType<string> }) {
const PROMOTION_STATUSES = ["draft", "active", "paused", "archived"] as const;

const jsonObjectSchema = z.record(z.string(), z.unknown());

const adminPromotionUnitTargetSchema = z.object({
  variantId: z.string().min(1),
  sku: z.string().nullable(),
  referenceMinor: z.number().int().positive(),
  targetMinor: z.number().int().nonnegative(),
  currency: platformCurrencySchema,
});

const adminPromotionSemanticBenefitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("target_percentage"),
    valueBps: z.number().int().min(1).max(9_999),
    reference: z.literal("catalog_list_price"),
    unitTargets: z.array(adminPromotionUnitTargetSchema),
  }),
  z.object({
    kind: z.literal("percentage"),
    valuePercent: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("fixed_amount"),
    valueMinor: z.number().nonnegative(),
    currency: platformCurrencySchema,
  }),
  z.object({ kind: z.literal("free_shipping") }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.literal("system_managed_metadata_incomplete"),
  }),
]);

/**
 * Engine-v2 mirror paired to a system-managed legacy row. Exposes only what the
 * deliberate human-operator activation/pause control needs; mirror semantics stay read-only.
 */
const adminPromotionV2MirrorSchema = z.object({
  id: z.string().min(1),
  status: z.enum(PROMOTION_STATUSES),
});

/** One promotion as shown in the admin editor. */
const adminPromotionSchema = z.object({
  id: z.string().min(1),
  code: z.string().nullable(),
  name: z.string(),
  triggerType: z.enum(PROMOTION_TRIGGER_TYPES),
  discountType: z.enum(PROMOTION_DISCOUNT_TYPES),
  semanticBenefit: adminPromotionSemanticBenefitSchema,
  systemManaged: z.boolean(),
  readOnly: z.boolean(),
  v2Mirror: adminPromotionV2MirrorSchema.nullable(),
  appliesToKind: z.enum(PROMOTION_APPLIES_TO_KINDS),
  stackingRule: z.enum(PROMOTION_STACKING_RULES),
  eligibility: jsonObjectSchema,
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.enum(PROMOTION_STATUSES),
  regionAvailability: z.array(z.string()),
  redemptionLimitGlobal: z.number().nullable(),
  redemptionLimitPerCustomer: z.number().nullable(),
});

const adminPromotionsListResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  promotions: z.array(adminPromotionSchema),
});

/** Editable fields. Trigger/discount type and code are fixed in v1 (edit, not recreate). */
const adminPromotionUpdatePayloadSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    discountValue: z.number().min(0).optional(),
    stackingRule: z.enum(PROMOTION_STACKING_RULES).optional(),
    status: z.enum(PROMOTION_STATUSES).optional(),
    eligibility: jsonObjectSchema.optional(),
    validFrom: z.string().optional(),
    validTo: z.string().nullable().optional(),
    redemptionLimitGlobal: z.number().int().positive().nullable().optional(),
    redemptionLimitPerCustomer: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((updates) => Object.values(updates).some((value) => value !== undefined), {
    message: "At least one promotion field is required",
  });

const adminPromotionUpdateRequestSchema = z
  .object({
    id: z.string().trim().min(1),
    updates: adminPromotionUpdatePayloadSchema,
  })
  .strict();

const adminPromotionUpdateResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  updated: z.literal(true),
  id: z.string().min(1),
});


return { PROMOTION_STATUSES, adminPromotionSemanticBenefitSchema, adminPromotionV2MirrorSchema, adminPromotionSchema, adminPromotionsListResponseSchema, adminPromotionUpdatePayloadSchema, adminPromotionUpdateRequestSchema, adminPromotionUpdateResponseSchema };
}

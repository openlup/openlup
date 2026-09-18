import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";

import {
  PROMOTION_APPLIES_TO_KINDS,
  PROMOTION_DISCOUNT_TYPES,
  PROMOTION_STACKING_RULES,
  PROMOTION_TRIGGER_TYPES,
} from "../promo/types.js";

import { COMMERCE_CONTRACT_VERSION } from "./types.js";

/**
 * Admin "Rabaty" surface contracts (preview-only, gated). Promotions are owned
 * by the commerce domain (DOMAIN_ARCHITECTURE.md: commerce "owns … discounts");
 * these schemas reuse the pure promo enums from the `promo` subdomain and never
 * expose raw Supabase rows — the BFF maps rows into these shapes.
 */

export const PROMOTION_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

const jsonObjectSchema = z.record(z.string(), z.unknown());

const adminPromotionUnitTargetSchema = z.object({
  variantId: z.string().min(1),
  sku: z.string().nullable(),
  referenceMinor: z.number().int().positive(),
  targetMinor: z.number().int().nonnegative(),
  currency: platformCurrencySchema,
});

export const adminPromotionSemanticBenefitSchema = z.discriminatedUnion("kind", [
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
 * deliberate human-operator activation/pause control needs (runbook
 * PROMOTION_V2_PRODUCTION_ACTIVATION step c); mirror semantics stay read-only.
 */
export const adminPromotionV2MirrorSchema = z.object({
  id: z.string().min(1),
  status: z.enum(PROMOTION_STATUSES),
});

/** One promotion as shown in the admin editor. */
export const adminPromotionSchema = z.object({
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

export const adminPromotionsListResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  promotions: z.array(adminPromotionSchema),
});

/** Editable fields. Trigger/discount type and code are fixed in v1 (edit, not recreate). */
export const adminPromotionUpdatePayloadSchema = z
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

export const adminPromotionUpdateRequestSchema = z
  .object({
    id: z.string().trim().min(1),
    updates: adminPromotionUpdatePayloadSchema,
  })
  .strict();

export const adminPromotionUpdateResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  updated: z.literal(true),
  id: z.string().min(1),
});

/** Subscription price band (the recurring ~10%): one row per SKU, derived %. */
export const adminSubscriptionBandEntrySchema = z.object({
  variantId: z.string().min(1),
  sku: z.string().nullable(),
  oneTimeMinor: z.number().int().nonnegative(),
  subscriptionMinor: z.number().int().nonnegative(),
  percent: z.number(),
});

export const adminSubscriptionBandResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  /** Uniform band percent when all SKUs share it; null when they diverge or none. */
  currentPercent: z.number().nullable(),
  entries: z.array(adminSubscriptionBandEntrySchema),
});

export const adminSetSubscriptionBandRequestSchema = z
  .object({
    percent: z.number().min(0).max(99),
  })
  .strict();

export const adminSetSubscriptionBandResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  updated: z.literal(true),
  appliedPercent: z.number(),
  updatedSkuCount: z.number().int().nonnegative(),
});

/** Flat shipping rate (gross minor units) charged when no free-shipping promo applies. */
export const adminShippingRateResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  shippingFlatMinor: z.number().int().nonnegative(),
});

export const adminSetShippingRateRequestSchema = z
  .object({
    // Cap at 1000.00 zl to fat-finger-guard a runaway shipping charge.
    shippingFlatMinor: z.number().int().nonnegative().max(100000),
  })
  .strict();

export const adminSetShippingRateResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  updated: z.literal(true),
  shippingFlatMinor: z.number().int().nonnegative(),
});

/**
 * Set a SKU's one-time (list) price — the base the subscription band re-prices
 * from. Subscription prices are NOT touched here; re-apply the band afterwards to
 * recompute them. Cap at 1000.00 zl to fat-finger-guard a runaway list price.
 */
export const adminSetCatalogPriceRequestSchema = z
  .object({
    sku: z.string().trim().min(1),
    unitPriceMinor: z.number().int().positive().max(100000),
  })
  .strict();

export const adminSetCatalogPriceResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  updated: z.literal(true),
  sku: z.string().min(1),
});

export type AdminPromotion = z.infer<typeof adminPromotionSchema>;
export type AdminPromotionV2Mirror = z.infer<typeof adminPromotionV2MirrorSchema>;
export type AdminPromotionSemanticBenefit = z.infer<typeof adminPromotionSemanticBenefitSchema>;
export type AdminPromotionsListResponse = z.infer<typeof adminPromotionsListResponseSchema>;
export type AdminPromotionUpdatePayload = z.infer<typeof adminPromotionUpdatePayloadSchema>;
export type AdminPromotionUpdateRequest = z.infer<typeof adminPromotionUpdateRequestSchema>;
export type AdminPromotionUpdateResponse = z.infer<typeof adminPromotionUpdateResponseSchema>;
export type AdminSubscriptionBandEntry = z.infer<typeof adminSubscriptionBandEntrySchema>;
export type AdminSubscriptionBandResponse = z.infer<typeof adminSubscriptionBandResponseSchema>;
export type AdminSetSubscriptionBandRequest = z.infer<typeof adminSetSubscriptionBandRequestSchema>;
export type AdminSetSubscriptionBandResponse = z.infer<typeof adminSetSubscriptionBandResponseSchema>;
export type AdminShippingRateResponse = z.infer<typeof adminShippingRateResponseSchema>;
export type AdminSetShippingRateRequest = z.infer<typeof adminSetShippingRateRequestSchema>;
export type AdminSetShippingRateResponse = z.infer<typeof adminSetShippingRateResponseSchema>;
export type AdminSetCatalogPriceRequest = z.infer<typeof adminSetCatalogPriceRequestSchema>;
export type AdminSetCatalogPriceResponse = z.infer<typeof adminSetCatalogPriceResponseSchema>;

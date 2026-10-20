import { z } from "../../lib/validation/zod.js";
import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { createAdminPromotionSchemas } from "@openlup/platform/promotions";
export const { PROMOTION_STATUSES, adminPromotionSemanticBenefitSchema, adminPromotionV2MirrorSchema, adminPromotionSchema, adminPromotionsListResponseSchema, adminPromotionUpdatePayloadSchema, adminPromotionUpdateRequestSchema, adminPromotionUpdateResponseSchema } = createAdminPromotionSchemas({ currencySchema: platformCurrencySchema });
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];
export type AdminPromotion = z.infer<typeof adminPromotionSchema>;
export type AdminPromotionV2Mirror = z.infer<typeof adminPromotionV2MirrorSchema>;
export type AdminPromotionSemanticBenefit = z.infer<typeof adminPromotionSemanticBenefitSchema>;
export type AdminPromotionsListResponse = z.infer<typeof adminPromotionsListResponseSchema>;
export type AdminPromotionUpdatePayload = z.infer<typeof adminPromotionUpdatePayloadSchema>;
export type AdminPromotionUpdateRequest = z.infer<typeof adminPromotionUpdateRequestSchema>;
export type AdminPromotionUpdateResponse = z.infer<typeof adminPromotionUpdateResponseSchema>;
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
    // Cap at 100000 minor units to fat-finger-guard a runaway shipping charge.
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

export type AdminSubscriptionBandEntry = z.infer<typeof adminSubscriptionBandEntrySchema>;
export type AdminSubscriptionBandResponse = z.infer<typeof adminSubscriptionBandResponseSchema>;
export type AdminSetSubscriptionBandRequest = z.infer<typeof adminSetSubscriptionBandRequestSchema>;
export type AdminSetSubscriptionBandResponse = z.infer<typeof adminSetSubscriptionBandResponseSchema>;
export type AdminShippingRateResponse = z.infer<typeof adminShippingRateResponseSchema>;
export type AdminSetShippingRateRequest = z.infer<typeof adminSetShippingRateRequestSchema>;
export type AdminSetShippingRateResponse = z.infer<typeof adminSetShippingRateResponseSchema>;
export type AdminSetCatalogPriceRequest = z.infer<typeof adminSetCatalogPriceRequestSchema>;
export type AdminSetCatalogPriceResponse = z.infer<typeof adminSetCatalogPriceResponseSchema>;

import { z } from "zod";

import type { CommerceOfferAvailabilityRequestItem } from "./contracts/index.js";

/** Bind the existing product identifier and SKU validators without importing a host. */
export function createOfferAvailabilitySchemas(
  catalogProductSlugSchema: z.ZodType<string, string>,
  commerceSkuSchema: z.ZodType<string, string>,
) {
const commerceOfferAvailabilityStatusSchema = z.enum([
  "available",
  "low_stock",
  "out_of_stock",
  "unknown",
]);

const commerceOfferAvailabilitySourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(80);

const commerceOfferAvailabilityRequestItemSchema = z
  .object({
    sku: commerceSkuSchema,
    productSlug: catalogProductSlugSchema,
    variantId: z.string().trim().min(1).max(120),
    requestedQuantity: z.number().int().positive().default(1),
    checkoutMode: z.enum(["one_time", "subscription"]).default("one_time"),
  })
  .strict();

const commerceOfferAvailabilitySchema = z
  .object({
    sku: commerceSkuSchema,
    productSlug: catalogProductSlugSchema,
    variantId: z.string().trim().min(1).max(120),
    status: commerceOfferAvailabilityStatusSchema,
    visibleInConfigurator: z.boolean(),
    sellableNow: z.number().int().nonnegative().nullable(),
    reasonCode: z.string().trim().min(1).max(120),
    source: commerceOfferAvailabilitySourceSchema,
  })
  .strict();

return { commerceOfferAvailabilityStatusSchema, commerceOfferAvailabilitySourceSchema, commerceOfferAvailabilityRequestItemSchema, commerceOfferAvailabilitySchema };
}

/** One request per variant, preserving order and checkout mode. */
export function offerAvailabilityRequestItems(
  variants: readonly { sku: string; slug: string; variantId: string }[],
  checkoutMode: CommerceOfferAvailabilityRequestItem["checkoutMode"],
): CommerceOfferAvailabilityRequestItem[] {
  return variants.map(variant => ({ sku: variant.sku, productSlug: variant.slug,
    variantId: variant.variantId, requestedQuantity: 1, checkoutMode }));
}

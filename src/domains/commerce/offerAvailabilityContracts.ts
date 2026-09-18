import { z } from "../../lib/validation/zod.js";

import { catalogProductSlugSchema } from "../catalog/contracts.js";
import { commerceSkuSchema } from "./contracts.js";

export const commerceOfferAvailabilityStatusSchema = z.enum([
  "available",
  "low_stock",
  "out_of_stock",
  "unknown",
]);

export const commerceOfferAvailabilitySourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(80);

export const commerceOfferAvailabilityRequestItemSchema = z
  .object({
    sku: commerceSkuSchema,
    productSlug: catalogProductSlugSchema,
    variantId: z.string().trim().min(1).max(120),
    requestedQuantity: z.number().int().positive().default(1),
    checkoutMode: z.enum(["one_time", "subscription"]).default("one_time"),
  })
  .strict();

export const commerceOfferAvailabilitySchema = z
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

export type CommerceOfferAvailabilityStatus = z.infer<
  typeof commerceOfferAvailabilityStatusSchema
>;
export type CommerceOfferAvailabilityRequestItem = z.infer<
  typeof commerceOfferAvailabilityRequestItemSchema
>;
export type CommerceOfferAvailability = z.infer<
  typeof commerceOfferAvailabilitySchema
>;

import { z } from "../../lib/validation/zod.js";

import {
  catalogAllergenSlugSchema,
  catalogProductSlugSchema,
} from "../catalog/contracts.js";
import { commerceOfferAvailabilityStatusSchema } from "./offerAvailabilityContracts.js";

export const COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION =
  "commerce.product_compatibility.v1";

// Open value space — format-validated slugs, not closed enums (see slugFormat.ts).
const allergenSlugSchema = catalogAllergenSlugSchema;
const productSlugSchema = catalogProductSlugSchema;

export const commerceProductCompatibilityRequestSchema = z
  .object({
    allergenSlugs: z.array(allergenSlugSchema).max(20).default([]),
  })
  .strict();

export const commerceProductCompatibilityItemSchema = z
  .object({
    variantId: z.string().trim().min(1),
    sku: z.string().trim().min(1),
    slug: productSlugSchema,
    selectable: z.boolean(),
    purchaseAvailability: commerceOfferAvailabilityStatusSchema.optional(),
    visibleInConfigurator: z.boolean().optional(),
    // Internal stock-enforcement passthrough (see recommendation line schema).
    // Never rendered as a number; additive optional/nullable field.
    sellableNow: z.number().int().nonnegative().nullable().optional(),
    conflictAllergenSlugs: z.array(allergenSlugSchema),
  })
  .strict();

export const commerceProductCompatibilityResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION),
    products: z.array(commerceProductCompatibilityItemSchema).max(50),
  })
  .strict();

export type CommerceProductCompatibilityRequest = z.infer<
  typeof commerceProductCompatibilityRequestSchema
>;
export type CommerceProductCompatibilityItem = z.infer<
  typeof commerceProductCompatibilityItemSchema
>;
export type CommerceProductCompatibilityResponse = z.infer<
  typeof commerceProductCompatibilityResponseSchema
>;

import { z } from "../../lib/validation/zod.js";

import { catalogProductSlugSchema } from "../catalog/contracts.js";
import { commerceMoneySchema } from "./contractPrimitives.js";
import { pricingPolicySnapshotSchema } from "./offerPolicyContracts.js";

export const COMMERCE_OFFER_PRICING_CONTRACT_VERSION =
  "commerce.offer-pricing.v1" as const;
export const COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION =
  "commerce.offer-pricing.v2" as const;

const offerPriceSchema = z
  .object({
    packageGross: commerceMoneySchema,
    unitGross: commerceMoneySchema,
  })
  .strict();

export const commerceProductOfferPricingSchema = z
  .object({
    productSlug: catalogProductSlugSchema,
    unitCount: z.number().int().positive(),
    oneTime: offerPriceSchema,
    subscriptionInitial: offerPriceSchema,
    subscriptionRecurring: offerPriceSchema,
    catalogAnchorUnitGross: commerceMoneySchema,
    initialDiscountPercent: z.number().int().min(0).max(100),
    recurringDiscountPercent: z.number().int().min(0).max(100),
  })
  .strict();

export const commerceOfferPricingV1ResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_OFFER_PRICING_CONTRACT_VERSION),
    scope: z.literal("dog_products_only_excludes_shipping"),
    products: z.array(commerceProductOfferPricingSchema).min(1),
    minimum: z
      .object({
        oneTime: commerceProductOfferPricingSchema,
        subscription: commerceProductOfferPricingSchema,
      })
      .strict(),
  })
  .strict();

export const commerceOfferPricingV2ResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION),
    scope: z.literal("dog_products_and_shipping"),
    pricingPolicy: pricingPolicySnapshotSchema,
    products: z.array(commerceProductOfferPricingSchema).min(1),
    minimum: z.object({
      oneTime: commerceProductOfferPricingSchema,
      subscription: commerceProductOfferPricingSchema,
    }).strict(),
    shipping: z.object({
      gross: commerceMoneySchema,
      discountGross: commerceMoneySchema,
      payable: commerceMoneySchema,
    }).strict(),
    minimumProductPayable: commerceMoneySchema,
  })
  .strict()
  .refine(
    (value) =>
      value.pricingPolicy.offerPolicyVersion === "commerce.offer-policy.v2" &&
      value.pricingPolicy.promotionEngineVersion === "promotion-engine.v2",
    { message: "offer-pricing v2 requires the paired v2 policy", path: ["pricingPolicy"] },
  )
  .refine(
    (value) => value.minimumProductPayable.amountMinor === 100,
    { message: "offer-pricing v2 requires the 1 PLN product floor", path: ["minimumProductPayable"] },
  )
  .refine(
    (value) =>
      value.shipping.payable.amountMinor ===
      value.shipping.gross.amountMinor - value.shipping.discountGross.amountMinor,
    { message: "offer-pricing v2 shipping arithmetic is inconsistent", path: ["shipping"] },
  );

export const commerceOfferPricingResponseSchema = z.union([
  commerceOfferPricingV1ResponseSchema,
  commerceOfferPricingV2ResponseSchema,
]);

export type CommerceProductOfferPricing = z.infer<
  typeof commerceProductOfferPricingSchema
>;
export type CommerceOfferPricingResponse = z.infer<
  typeof commerceOfferPricingResponseSchema
>;

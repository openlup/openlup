import { z } from "zod";
import type { CommerceMoney } from "./contracts/money.js";
import { COMMERCE_OFFER_PRICING_CONTRACT_VERSION, COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION } from "./contracts/offer.js";
import { pricingPolicySnapshotSchema } from "./offerPolicySchemas.js";
export function createCommerceOfferPricingSchemas<ScopeV1 extends string, ScopeV2 extends string>({
  commerceMoneySchema, catalogProductSlugSchema, scopeV1Schema, scopeV2Schema,
  minimumProductPayableMinor, minimumProductPayableMessage,
}: {
  commerceMoneySchema: z.ZodType<CommerceMoney>;
  catalogProductSlugSchema: z.ZodType<string>;
  scopeV1Schema: z.ZodType<ScopeV1>;
  scopeV2Schema: z.ZodType<ScopeV2>;
  minimumProductPayableMinor: number;
  minimumProductPayableMessage: string;
}) {
const offerPriceSchema = z
  .object({
    packageGross: commerceMoneySchema,
    unitGross: commerceMoneySchema,
  })
  .strict();

const commerceProductOfferPricingSchema = z
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

const commerceOfferPricingV1ResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_OFFER_PRICING_CONTRACT_VERSION),
    scope: scopeV1Schema,
    products: z.array(commerceProductOfferPricingSchema).min(1),
    minimum: z
      .object({
        oneTime: commerceProductOfferPricingSchema,
        subscription: commerceProductOfferPricingSchema,
      })
      .strict(),
  })
  .strict();

const commerceOfferPricingV2ResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION),
    scope: scopeV2Schema,
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
    (value) => value.minimumProductPayable.amountMinor === minimumProductPayableMinor,
    { message: minimumProductPayableMessage, path: ["minimumProductPayable"] },
  )
  .refine(
    (value) =>
      value.shipping.payable.amountMinor ===
      value.shipping.gross.amountMinor - value.shipping.discountGross.amountMinor,
    { message: "offer-pricing v2 shipping arithmetic is inconsistent", path: ["shipping"] },
  );

const commerceOfferPricingResponseSchema = z.union([
  commerceOfferPricingV1ResponseSchema,
  commerceOfferPricingV2ResponseSchema,
]);

return { commerceProductOfferPricingSchema, commerceOfferPricingV1ResponseSchema,
  commerceOfferPricingV2ResponseSchema, commerceOfferPricingResponseSchema };
}

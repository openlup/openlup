import { z } from "../../lib/validation/zod.js";
import { catalogAllergenSlugSchema } from "../catalog/contracts.js";
import {
  commerceCurrencySchema,
  commerceMoneySchema,
  commerceProductSlugSchema,
  commerceSizeConstraintSchema,
  commerceSkuSchema,
  commerceTaxCategorySchema,
  commerceTaxCountrySchema,
  commerceTaxLegalBasisSchema,
} from "./contractPrimitives.js";
import { starterPackPlanSchema } from "./starterOfferContracts.js";
import { COMMERCE_CONTRACT_VERSION, type CommerceQuote } from "./types.js";
import { catalogFactsProvenanceSchema, rejectCatalogFactsFromPublicQuote } from "./catalogFactsProvenance.js";
import {
  pricingPolicyRequestSchema,
  pricingPolicySnapshotSchema,
} from "./offerPolicyContracts.js";
import { quoteDiscountSchema } from "./quotePromotionEvidence.js";
import { quoteCodeRejectionDetailSchema } from "./quoteCodeRejectionDetails.js";
export { quoteDiscountSchema } from "./quotePromotionEvidence.js";
export { quoteCodeRejectionDetailSchema } from "./quoteCodeRejectionDetails.js";
export const quotePricingComponentSchema = z
  .object({
    scope: z.enum(["line", "order"]),
    componentType: z.enum(["base_unit", "mode_discount", "qty_tier", "promo", "loyalty", "shipping", "bundle"]),
    amountMinor: z.number().int(),
    reasonCode: z.string().trim().min(1).max(120),
    reasonPayload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const cartLineInputSchema = z.object({
  sku: commerceSkuSchema,
  quantity: z.number().int().min(1).max(99),
  variantId: z.string().trim().min(1).max(120).optional(),
  modeAtLine: z.enum(["one_time", "subscription"]).optional(),
  isAddon: z.boolean().optional(),
});
export const quoteSizeConstraintSchema = commerceSizeConstraintSchema;
export const quotePetProfileContextSchema = z
  .object({
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    ageBand: z.enum(["puppy", "young", "adult", "senior"]).optional(),
    breed: z.string().trim().min(1).max(120).optional(),
    weightKg: z.number().positive().max(120).optional(),
    activityLevel: z.enum(["low", "normal", "high"]).optional(),
    bcs: z.enum(["thin", "ideal", "overweight"]).optional(),
    allergenSlugs: z.array(catalogAllergenSlugSchema).optional(),
    dailyKcalOverride: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const quoteCustomerEligibilityContextSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(320).optional(),
    visitorId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const quoteContextSchema = z
  .object({
    mode: z.enum(["one_time", "subscription"]),
    cadenceDays: z.number().int().positive().max(120).nullable().optional(),
    feedingCoverageDays: z.number().positive().nullable().optional(),
    sizeConstraint: quoteSizeConstraintSchema.optional(),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    petProfileContext: quotePetProfileContextSchema.optional(),
    pricingPolicy: pricingPolicySnapshotSchema.optional(),
    // SERVER-MINTED ONLY: injected by the checkout quote guard after pricing, never
    // accepted from a client, read by the provisional-creation RPC to seed the marker.
    starterPack: starterPackPlanSchema.optional(),
  })
  .strict();

export const commerceTaxBreakdownSchema = z
  .object({
    included: z.literal(true),
    country: commerceTaxCountrySchema,
    category: commerceTaxCategorySchema,
    vatRateBps: z.number().int().min(0).max(10_000),
    legalBasis: commerceTaxLegalBasisSchema,
    netAmount: commerceMoneySchema,
    vatAmount: commerceMoneySchema,
    grossAmount: commerceMoneySchema,
  })
  .refine(
    (tax) =>
      tax.netAmount.currency === tax.vatAmount.currency &&
      tax.netAmount.currency === tax.grossAmount.currency &&
      tax.netAmount.amountMinor + tax.vatAmount.amountMinor === tax.grossAmount.amountMinor,
    {
      message: "tax net and VAT amounts must add up to gross amount",
      path: ["grossAmount"],
    },
  );

export const quoteLineSchema = z
  .object({
    sku: commerceSkuSchema,
    productSlug: commerceProductSlugSchema,
    quantity: z.number().int().min(1).max(99),
    unitPriceGross: commerceMoneySchema,
    lineSubtotalGross: commerceMoneySchema,
    tax: commerceTaxBreakdownSchema,
    pricingComponents: z.array(quotePricingComponentSchema).optional(),
    catalogFacts: catalogFactsProvenanceSchema.optional(),
  })
  .refine(
    (line) =>
      line.unitPriceGross.currency === line.lineSubtotalGross.currency &&
      line.lineSubtotalGross.currency === line.tax.grossAmount.currency &&
      line.unitPriceGross.amountMinor * line.quantity === line.lineSubtotalGross.amountMinor,
    {
      message: "quote line subtotal must match unit price and quantity",
      path: ["lineSubtotalGross"],
    },
  );

export const quoteCodeRejectionSchema = z
  .object({
    code: z.string().trim().min(1).max(80),
    reason: z.enum([
      "not_recognized",
      "already_used",
      "not_eligible",
      "expired",
      "better_price_exists",
      "scope_not_applicable",
    ]),
  })
  .strict();

/** Split gross tax-included money into net/VAT using an explicit tax rate. */
export function splitIncludedVat(grossMinor: number, vatRateBps: number): { netMinor: number; vatMinor: number } {
  const netMinor = Math.round((grossMinor * 10_000) / (10_000 + vatRateBps));
  const vatMinor = grossMinor - netMinor;
  return { netMinor, vatMinor };
}

/** Backstop: every Money in a quote must use the quote's own currency. */
export function quoteMoneyCurrenciesMatch(quote: CommerceQuote): boolean {
  const monies = [
    quote.subtotalGross,
    quote.discountTotalGross,
    ...(quote.shippingGross ? [quote.shippingGross] : []),
    ...(quote.shippingDiscountGross ? [quote.shippingDiscountGross] : []),
    quote.totalGross,
    quote.netTotal,
    quote.taxTotal,
    ...quote.lines.flatMap((line) => [
      line.unitPriceGross,
      line.lineSubtotalGross,
      line.tax.netAmount,
      line.tax.vatAmount,
      line.tax.grossAmount,
    ]),
  ];
  return monies.every((money) => money.currency === quote.currency);
}

export const commerceQuoteSchema = z
  .object({
    currency: commerceCurrencySchema,
    taxIncluded: z.literal(true),
    lines: z.array(quoteLineSchema).min(1).max(50),
    discounts: z.array(quoteDiscountSchema).max(20),
    codeRejections: z.array(quoteCodeRejectionSchema).max(20).optional(),
    codeRejectionDetails: z.array(quoteCodeRejectionDetailSchema).max(20).optional(),
    pricingComponents: z.array(quotePricingComponentSchema).optional(),
    context: quoteContextSchema.optional(),
    subtotalGross: commerceMoneySchema,
    discountTotalGross: commerceMoneySchema,
    // Shipping/discount tax split uses one quote rate; mixed-tax allocation is out of scope.
    shippingGross: commerceMoneySchema.optional(),
    shippingDiscountGross: commerceMoneySchema.optional(),
    totalGross: commerceMoneySchema,
    netTotal: commerceMoneySchema,
    taxTotal: commerceMoneySchema,
  })
  .refine((quote) => quote.lines.every((line) => line.tax.vatRateBps === quote.lines[0]?.tax.vatRateBps), {
    message: "mixed VAT rates are not supported by quote discount and shipping tax allocation",
    path: ["lines"],
  })
  .refine(
    (quote) => {
      const subtotal = sumAmounts(quote.lines.map((line) => line.lineSubtotalGross));
      const lineNet = sumAmounts(quote.lines.map((line) => line.tax.netAmount));
      const lineVat = sumAmounts(quote.lines.map((line) => line.tax.vatAmount));
      const vatRateBps = quote.lines[0]?.tax.vatRateBps ?? 0;
      const singleTaxRate = quote.lines.every((line) => line.tax.vatRateBps === vatRateBps);
      const discountTotal = quote.discountTotalGross.amountMinor;
      const orderDiscountSum = quote.discounts
        .filter((discount) => discount.appliesTo !== "shipping")
        .reduce((sum, discount) => sum + discount.amountOffMinor, 0);
      const shippingDiscountSum = quote.discounts
        .filter((discount) => discount.appliesTo === "shipping")
        .reduce((sum, discount) => sum + discount.amountOffMinor, 0);
      const shippingGross = quote.shippingGross?.amountMinor ?? 0;
      const shippingDiscount = quote.shippingDiscountGross?.amountMinor ?? 0;
      const { netMinor: discountNet, vatMinor: discountVat } = splitIncludedVat(discountTotal, vatRateBps);
      const { netMinor: shipNet, vatMinor: shipVat } = splitIncludedVat(shippingGross, vatRateBps);
      const { netMinor: shipDiscNet, vatMinor: shipDiscVat } = splitIncludedVat(shippingDiscount, vatRateBps);

      return (
        singleTaxRate &&
        quote.subtotalGross.amountMinor === subtotal &&
        discountTotal >= 0 &&
        discountTotal <= subtotal &&
        orderDiscountSum === discountTotal &&
        shippingGross >= 0 &&
        shippingDiscount >= 0 &&
        shippingDiscount <= shippingGross &&
        shippingDiscountSum === shippingDiscount &&
        quote.totalGross.amountMinor === subtotal - discountTotal + shippingGross - shippingDiscount &&
        quote.netTotal.amountMinor === lineNet - discountNet + shipNet - shipDiscNet &&
        quote.taxTotal.amountMinor === lineVat - discountVat + shipVat - shipDiscVat &&
        quote.netTotal.amountMinor + quote.taxTotal.amountMinor === quote.totalGross.amountMinor
      );
    },
    {
      message: "quote totals must match quote lines, discounts and shipping",
      path: ["totalGross"],
    },
  )
  // Cast bridges Zod's degraded infer under the app project's non-strict tsconfig (it
  // marks every field optional); the value is a fully-validated quote by the time the
  // refine runs.
  .refine((quote) => quoteMoneyCurrenciesMatch(quote as CommerceQuote), {
    message: "all quote money amounts must use the quote currency",
    path: ["currency"],
  });

const createQuoteRequestShape = {
    mode: z.enum(["one_time", "subscription"]).default("one_time"),
    lines: z.array(cartLineInputSchema).min(1).max(50),
    sizeConstraint: quoteSizeConstraintSchema.optional(),
    cadenceDays: z.number().int().positive().max(120).nullable().optional(),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    petProfileContext: quotePetProfileContextSchema.optional(),
    locale: z.enum(["pl", "en"]).optional(),
    // Persistent first-party visitor id for the device first-order guard. Advisory at
    // quote time; authoritative re-evaluation happens at checkout with the same id.
    visitorId: z.string().trim().min(1).max(120).optional(),
    // Optional customer context lets the public quote route resolve an existing
    // client out-of-band and evaluate first-subscription eligibility with the
    // same facts checkout will use. Client-supplied ids are intentionally not
    // accepted; the server may only derive clientId from this context.
    customerEligibilityContext: quoteCustomerEligibilityContextSchema.optional(),
    pricingPolicy: pricingPolicyRequestSchema.optional(),
};

function validateQuoteRequest(
  request: { mode: "one_time" | "subscription"; cadenceDays?: number | null },
  ctx: z.RefinementCtx,
): void {
    if (request.mode === "subscription" && !request.cadenceDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscription quote requires cadenceDays",
        path: ["cadenceDays"],
      });
    }
}

export const createQuoteRequestSchema = z.object(createQuoteRequestShape)
  .superRefine(validateQuoteRequest);

export const publicCreateQuoteRequestSchema = z.object({
  ...createQuoteRequestShape,
  promotionAcceptanceToken: z.string().min(1).max(8_300).optional(),
}).superRefine(validateQuoteRequest);

export const createQuoteResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  quote: commerceQuoteSchema,
}).strict();

export const publicCreateQuoteResponseSchema = createQuoteResponseSchema.extend({
  promotionAcceptanceToken: z.string().min(1).max(8_300).optional(),
}).superRefine(rejectCatalogFactsFromPublicQuote);

// Batch prices independent quotes in one round-trip and preserves request order.
export const createQuoteBatchRequestSchema = z.object({
  quotes: z.array(createQuoteRequestSchema).min(1).max(8),
});

export const createQuoteBatchResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  quotes: z.array(commerceQuoteSchema),
});
export const publicCreateQuoteBatchResponseSchema = createQuoteBatchResponseSchema
  .superRefine((response, ctx) => response.quotes.forEach((quote, index) =>
    rejectCatalogFactsFromPublicQuote({ quote }, ctx, ["quotes", index])));

function sumAmounts(amounts: Array<{ amountMinor?: number }>): number {
  return amounts.reduce((sum, amount) => sum + (amount.amountMinor ?? 0), 0);
}

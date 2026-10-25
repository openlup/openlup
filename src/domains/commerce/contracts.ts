import { z } from "../../lib/validation/zod.js";
import {
  cartStatusSchema,
  checkoutStatusSchema,
  commerceCurrencySchema,
  commerceIdempotencyKeySchema,
  commerceMoneySchema,
  orderDraftStatusSchema,
  orderStatusSchema,
  paymentStatusSchema,
} from "./contractPrimitives.js";
import {
  cartLineInputSchema,
  createQuoteBatchRequestSchema,
  createQuoteBatchResponseSchema,
  publicCreateQuoteBatchResponseSchema,
  createQuoteRequestSchema,
  createQuoteResponseSchema,
  publicCreateQuoteRequestSchema,
  publicCreateQuoteResponseSchema,
} from "./quoteContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

export {
  cartStatusSchema,
  checkoutStatusSchema,
  commerceCurrencySchema,
  commerceIdempotencyKeySchema,
  commerceMoneySchema,
  commerceProductSlugSchema,
  commerceSkuSchema,
  commerceTaxCategorySchema,
  commerceTaxCountrySchema,
  commerceTaxLegalBasisSchema,
  orderDraftStatusSchema,
  orderStatusSchema,
  paymentStatusSchema,
} from "./contractPrimitives.js";

export {
  cartLineInputSchema,
  commerceQuoteSchema,
  commerceTaxBreakdownSchema,
  createQuoteBatchRequestSchema,
  createQuoteBatchResponseSchema,
  publicCreateQuoteBatchResponseSchema,
  createQuoteRequestSchema,
  createQuoteResponseSchema,
  publicCreateQuoteRequestSchema,
  publicCreateQuoteResponseSchema,
  quoteContextSchema,
  quoteCustomerEligibilityContextSchema,
  quoteCodeRejectionDetailSchema,
  quoteDiscountSchema,
  quoteLineSchema,
  quoteMoneyCurrenciesMatch,
  quotePetProfileContextSchema,
  quotePricingComponentSchema,
  quoteSizeConstraintSchema,
  splitIncludedVat,
} from "./quoteContracts.js";

// The frozen starter-pack acquisition plan. Re-exported on the public surface
// because the subscription domain reads the same shape back out of
// `subscriptions.starter_pack`; see the parity proof in
// `server/domains/subscription/starterPackMarkerParity.test.ts`.
export { starterPackPlanSchema, type StarterPackPlan } from "./starterOfferContracts.js";

import { createCommerceSchemas } from "@openlup/platform/commerce";
export { commerceOfferVersionSchema } from "@openlup/platform/commerce";
const core = createCommerceSchemas({ cartLineInputSchema, commerceCurrencySchema, commerceMoneySchema, createQuoteResponseSchema, contractVersion: COMMERCE_CONTRACT_VERSION });
export const createCartRequestSchema = core.createCartRequestSchema.omit({ clientId: true }).extend({
  locale: z.enum(["pl", "en"]).optional(),
  clientId: core.createCartRequestSchema.shape.clientId,
});
export const { cartDraftSchema, createCartResponseSchema, createCheckoutRequestSchema, createCheckoutResponseSchema, orderDraftSummarySchema, createOrderDraftRequestSchema, createOrderDraftResponseSchema, orderSummarySchema, orderReadResponseSchema, paymentSummarySchema, paymentStatusReadResponseSchema } = core;

export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;
export type CreateQuoteRequestInput = z.input<typeof createQuoteRequestSchema>;
export type CreateQuoteResponse = z.infer<typeof createQuoteResponseSchema>;
export type PublicCreateQuoteRequest = z.infer<typeof publicCreateQuoteRequestSchema>;
export type PublicCreateQuoteRequestInput = z.input<typeof publicCreateQuoteRequestSchema>;
export type PublicCreateQuoteResponse = z.infer<typeof publicCreateQuoteResponseSchema>;
export type CreateQuoteBatchRequest = z.infer<typeof createQuoteBatchRequestSchema>;
export type CreateQuoteBatchRequestInput = z.input<typeof createQuoteBatchRequestSchema>;
export type CreateQuoteBatchResponse = z.infer<typeof createQuoteBatchResponseSchema>;
export type CreateOrderDraftRequest = z.infer<typeof createOrderDraftRequestSchema>;
export type CreateOrderDraftResponse = z.infer<typeof createOrderDraftResponseSchema>;

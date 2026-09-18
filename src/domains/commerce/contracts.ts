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

export const createCartRequestSchema = z.object({
  lines: z.array(cartLineInputSchema).min(1).max(50),
  locale: z.enum(["pl", "en"]).optional(),
  clientId: z.string().trim().min(1).optional(),
});

export const cartDraftSchema = z.object({
  id: z.string().regex(/^cart_[a-z0-9-]+$/),
  status: cartStatusSchema,
  lines: z.array(cartLineInputSchema).min(1),
  currency: commerceCurrencySchema,
});

export const createCartResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  cart: cartDraftSchema,
});

export const createCheckoutRequestSchema = z.object({
  cartId: z.string().regex(/^cart_[a-z0-9-]+$/),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export const createCheckoutResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
    checkout: z.object({
      id: z.string().regex(/^checkout_[a-z0-9-]+$/),
      cartId: z.string().regex(/^cart_[a-z0-9-]+$/),
      status: checkoutStatusSchema,
      redirectUrl: z.string().url().nullable(),
      paymentProviderSessionId: z.string().trim().min(1).nullable(),
    }),
  })
  .refine(
    ({ checkout }) =>
      checkout.status === "not_configured"
        ? checkout.redirectUrl === null && checkout.paymentProviderSessionId === null
        : checkout.redirectUrl !== null,
    {
      message: "checkout status must match redirect/provider fields",
      path: ["checkout"],
    },
  );

export const orderDraftSummarySchema = z.object({
  orderId: z.string().regex(/^order_[a-z0-9-]+$/),
  status: orderDraftStatusSchema,
  paymentStatus: z.literal("not_started"),
  idempotencyKey: commerceIdempotencyKeySchema,
  quoteSnapshot: createQuoteResponseSchema,
  replayed: z.boolean(),
});

export const createOrderDraftRequestSchema = z.object({
  idempotencyKey: commerceIdempotencyKeySchema,
  quoteSnapshot: createQuoteResponseSchema,
});
// NOTE: the customer client_id is NOT part of this public request body — it is
// passed OUT-OF-BAND via CreateOrderDraftOptions (mirroring CreateQuoteOptions),
// so the anonymous standalone /api/bff/commerce/order-draft route cannot have a
// forged client_id injected from the request to misattribute the order or its
// outbox email. The checkout saga supplies the provisioned client out-of-band.

export const createOrderDraftResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  orderDraft: orderDraftSummarySchema,
});

export const orderSummarySchema = z.object({
  id: z.string().regex(/^order_[a-z0-9-]+$/),
  status: orderStatusSchema,
  paymentStatus: paymentStatusSchema,
  total: commerceMoneySchema.nullable(),
  lines: z.array(cartLineInputSchema).min(1),
});

export const orderReadResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  order: orderSummarySchema,
});

export const paymentSummarySchema = z.object({
  id: z.string().regex(/^payment_[a-z0-9-]+$/),
  orderId: z.string().regex(/^order_[a-z0-9-]+$/),
  status: paymentStatusSchema,
  amount: commerceMoneySchema.nullable(),
  providerReference: z.string().trim().min(1).nullable(),
});

export const paymentStatusReadResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  payment: paymentSummarySchema,
});

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

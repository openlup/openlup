import { z } from "zod";
import { cartStatusSchema, checkoutStatusSchema, commerceIdempotencyKeySchema, orderDraftStatusSchema, orderStatusSchema, paymentStatusSchema } from "./contractPrimitives.js";

/** Preserve pricing validation and let the host extend cart locale policy. */
export function createCommerceSchemas<Line extends z.ZodType, Currency extends z.ZodType<string>, Money extends z.ZodType, Quote extends z.ZodType, Version extends string>(input: {
  cartLineInputSchema: Line; commerceCurrencySchema: Currency; commerceMoneySchema: Money;
  createQuoteResponseSchema: Quote; contractVersion: Version;
}) {
  const { cartLineInputSchema, commerceCurrencySchema, commerceMoneySchema, createQuoteResponseSchema } = input;
  const createCartRequestSchema = z.object({
    lines: z.array(cartLineInputSchema).min(1).max(50),
    clientId: z.string().trim().min(1).optional(),
  });

  const cartDraftSchema = z.object({
    id: z.string().regex(/^cart_[a-z0-9-]+$/),
    status: cartStatusSchema,
    lines: z.array(cartLineInputSchema).min(1),
    currency: commerceCurrencySchema,
  });

  const createCartResponseSchema = z.object({
    contractVersion: z.literal(input.contractVersion),
    cart: cartDraftSchema,
  });

  const createCheckoutRequestSchema = z.object({
    cartId: z.string().regex(/^cart_[a-z0-9-]+$/),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
  });

  const createCheckoutResponseSchema = z
    .object({
      contractVersion: z.literal(input.contractVersion),
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

  const orderDraftSummarySchema = z.object({
    orderId: z.string().regex(/^order_[a-z0-9-]+$/),
    status: orderDraftStatusSchema,
    paymentStatus: z.literal("not_started"),
    idempotencyKey: commerceIdempotencyKeySchema,
    quoteSnapshot: createQuoteResponseSchema,
    replayed: z.boolean(),
  });

  const createOrderDraftRequestSchema = z.object({
    idempotencyKey: commerceIdempotencyKeySchema,
    quoteSnapshot: createQuoteResponseSchema,
  });
  // Customer identity is supplied out of band by trusted composition, never
  // accepted from the public order-draft request body.

  const createOrderDraftResponseSchema = z.object({
    contractVersion: z.literal(input.contractVersion),
    orderDraft: orderDraftSummarySchema,
  });

  const orderSummarySchema = z.object({
    id: z.string().regex(/^order_[a-z0-9-]+$/),
    status: orderStatusSchema,
    paymentStatus: paymentStatusSchema,
    total: commerceMoneySchema.nullable(),
    lines: z.array(cartLineInputSchema).min(1),
  });

  const orderReadResponseSchema = z.object({
    contractVersion: z.literal(input.contractVersion),
    order: orderSummarySchema,
  });

  const paymentSummarySchema = z.object({
    id: z.string().regex(/^payment_[a-z0-9-]+$/),
    orderId: z.string().regex(/^order_[a-z0-9-]+$/),
    status: paymentStatusSchema,
    amount: commerceMoneySchema.nullable(),
    providerReference: z.string().trim().min(1).nullable(),
  });

  const paymentStatusReadResponseSchema = z.object({
    contractVersion: z.literal(input.contractVersion),
    payment: paymentSummarySchema,
  });

  return { createCartRequestSchema, cartDraftSchema, createCartResponseSchema, createCheckoutRequestSchema, createCheckoutResponseSchema, orderDraftSummarySchema, createOrderDraftRequestSchema, createOrderDraftResponseSchema, orderSummarySchema, orderReadResponseSchema, paymentSummarySchema, paymentStatusReadResponseSchema };
}

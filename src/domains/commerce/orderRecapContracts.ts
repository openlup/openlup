import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";
import { commerceSkuSchema } from "./contractPrimitives.js";

/**
 * Anonymous post-checkout order recap (W11.8).
 *
 * Powers the thank-you page across devices: after returning from the bank in a
 * different browser (or opening the confirmation link from the email), the page
 * no longer depends on the configurator's localStorage snapshot. The endpoint is
 * ownership-guarded — the caller must present BOTH the order UUID and the owning
 * client UUID (same guard model as `payment-status`); a mismatch is a 404, never
 * a partial leak. It intentionally carries only what the recap renders, not the
 * full order-detail surface (which stays JWT-gated behind `/customers/orders`).
 */
export const ORDER_RECAP_V2_CONTRACT_VERSION = "commerce.order.recap.v2";
export const ORDER_RECAP_V3_CONTRACT_VERSION = "commerce.order.recap.v3";
export const ORDER_RECAP_V4_CONTRACT_VERSION = "commerce.order.recap.v4";
export const ORDER_RECAP_CONTRACT_VERSION = ORDER_RECAP_V2_CONTRACT_VERSION;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });

const recapMoneySchema = z
  .object({
    amountMinor: z.number().int(),
    currency: platformCurrencySchema,
  })
  .strict();

const recapAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().min(1).max(200).nullable(),
    city: z.string().trim().min(1).max(160),
    postalCode: z.string().trim().min(1).max(16),
    country: z.literal("PL"),
  })
  .strict();

const recapLineSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    quantity: z.number().int().positive(),
    recipeName: z.string().max(160).nullable(),
    variantName: z.string().max(160).nullable(),
    total: recapMoneySchema,
    // Undiscounted list total for the line (sum of the `base_unit` pricing
    // components). Present only when the persisted quote line carries a
    // breakdown; null otherwise. When higher than `total`, the difference is the
    // saving the customer received and is rendered as an anchor price.
    listTotal: recapMoneySchema.nullable(),
    // Saving on this line (`listTotal - total`); null when unknown, and always
    // omitted from display when zero.
    discount: recapMoneySchema.nullable(),
  })
  .strict();

export const orderRecapRequestSchema = z
  .object({
    orderId: uuidSchema,
    clientId: uuidSchema,
    contractVersion: z
      .enum([
        ORDER_RECAP_V2_CONTRACT_VERSION,
        ORDER_RECAP_V3_CONTRACT_VERSION,
        ORDER_RECAP_V4_CONTRACT_VERSION,
      ])
      .optional(),
  })
  .strict();

export const orderRecapResponseSchema = z
  .object({
    contractVersion: z.literal(ORDER_RECAP_V2_CONTRACT_VERSION),
    orderId: uuidSchema,
    orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
    orderNumber: z.string().trim().min(1).nullable(),
    status: z.string().trim().min(1),
    paymentStatus: z.string().trim().min(1).nullable(),
    mode: z.enum(["one_time", "subscription"]),
    petId: uuidSchema.nullable().optional(),
    petName: z.string().trim().min(1).max(80).nullable(),
    customerFirstName: z.string().trim().min(1).max(80).nullable(),
    // Masked for display only (e.g. `j***@gmail.com`) — never the raw address.
    maskedEmail: z.string().trim().min(1).max(200).nullable(),
    cadenceDays: z.number().int().positive().max(120).nullable(),
    nextDeliveryAt: datetimeSchema.nullable(),
    items: z.array(recapLineSchema),
    totals: z
      .object({
        subtotal: recapMoneySchema,
        discount: recapMoneySchema,
        shipping: recapMoneySchema,
        shippingDiscount: recapMoneySchema,
        tax: recapMoneySchema,
        total: recapMoneySchema,
      })
      .strict(),
    shippingAddress: recapAddressSchema.nullable(),
    createdAt: datetimeSchema,
  })
  .strict();

const recapV3LineSchema = recapLineSchema
  .extend({
    sku: commerceSkuSchema.nullable(),
    variantCode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .nullable(),
    // Keep display available for a corrupt/unreconciled historical row; the
    // purchase projector validates non-negative ranges and exact equations.
    catalogUnitGross: z.number().int(),
    catalogTotalGross: z.number().int(),
    effectiveGross: z.number().int(),
    effectiveNet: z.number().int(),
    discountAllocated: z.number().int(),
    vatRateBps: z.number().int(),
  })
  .strict();

export const orderRecapV3ResponseSchema = orderRecapResponseSchema
  .omit({ contractVersion: true, items: true })
  .extend({
    contractVersion: z.literal(ORDER_RECAP_V3_CONTRACT_VERSION),
    checkoutKind: z.enum(["one_time", "subscription_initial"]).nullable(),
    moneyReconciled: z.boolean(),
    items: z.array(recapV3LineSchema),
  })
  .strict();

const firstSubscriptionPricePresentationSchema = z
  .object({
    catalogProductsMinor: z.number().int().positive(),
    productDiscountMinor: z.number().int().positive(),
    productPayableMinor: z.number().int().positive(),
    shippingGrossMinor: z.number().int().nonnegative(),
    shippingDiscountMinor: z.number().int().nonnegative(),
    shippingEffectiveMinor: z.number().int().nonnegative(),
    totalMinor: z.number().int().positive(),
    discountPercent: z.literal(50),
  })
  .strict();

/**
 * Negotiated receipt presentation for the proved first-subscription offer.
 * `null` is deliberate: historical or unreconciled orders must not reconstruct
 * an offer from today's catalogue or an incomplete snapshot.
 */
export const orderRecapV4ResponseSchema = orderRecapV3ResponseSchema
  .omit({ contractVersion: true })
  .extend({
    contractVersion: z.literal(ORDER_RECAP_V4_CONTRACT_VERSION),
    firstSubscriptionPricePresentation: firstSubscriptionPricePresentationSchema.nullable(),
  })
  .strict();

export type OrderRecapRequest = z.infer<typeof orderRecapRequestSchema>;
export type OrderRecapResponse = z.infer<typeof orderRecapResponseSchema>;
export type OrderRecapV3Response = z.infer<typeof orderRecapV3ResponseSchema>;
export type OrderRecapV4Response = z.infer<typeof orderRecapV4ResponseSchema>;

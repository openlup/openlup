import { z } from "zod";
export const CHECKOUT_CONTRACT_VERSION = "commerce.checkout.v2";
const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });

export const checkoutKindSchema = z.enum(["one_time", "subscription_initial"]);
export const checkoutActivationStatusSchema = z.enum([
  "not_applicable",
  "pending_payment_success",
  "activated",
  "blocked_missing_payment_method",
]);

export const ASYNC_CHECKOUT_STATUSES = [
  "pending_provider_action",
  "requires_action",
  "processing",
  "paid",
  "failed",
  "expired",
] as const;
export type AsyncCheckoutStatus = (typeof ASYNC_CHECKOUT_STATUSES)[number];

export const asyncCheckoutStatusSchema = z.enum(ASYNC_CHECKOUT_STATUSES);
export const subscriptionActivationStatusSchema = z.enum(["not_applicable", "waiting_for_mandate", "active", "action_required"]);
export const invoiceBuyerSnapshotAddressCoreSchema = z
  .object({
    line1: z.string().trim().min(3).max(160),
    line2: z.string().trim().min(1).max(160).nullable().default(null),
    city: z.string().trim().min(2).max(120),
    postalCode: z.string().trim().min(3).max(16),
    country: z.string().regex(/^[A-Z]{2}$/),
    source: z.string().trim().min(1).max(120),
  })
  .strict();


export const checkoutRequestCoreSchema = z.object({
  paymentAttemptSequence: z.number().int().min(0).max(50).optional(),
  returnContext: z.enum(["public", "account"]).default("public"),
}).strict();

/** Host composes fiscal, action and acquisition schemas over neutral checkout fields. */
export function createCheckoutResponseSchemas<Quote extends z.ZodType, Expectation extends z.ZodType,
  Action extends z.ZodType, IntentStatus extends z.ZodType<string>, AttemptStatus extends z.ZodType<string>, Display extends z.ZodType>(input: {
  quoteSchema: Quote; quoteExpectationSchema: Expectation; clientActionSchema: Action;
  paymentIntentStatusSchema: IntentStatus; paymentAttemptStatusSchema: AttemptStatus;
  failureDisplaySchema: Display;
}) {
  const createQuoteResponseSchema = input.quoteSchema;
  const checkoutClientActionSchema = input.clientActionSchema;
  const paymentFailureDisplayReasonSchema = input.failureDisplaySchema;
  const checkoutSuccessResponseSchema = z
    .object({
      contractVersion: z.literal(CHECKOUT_CONTRACT_VERSION),
      checkoutKind: checkoutKindSchema,
      orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
      orderId: uuidSchema,
      status: asyncCheckoutStatusSchema,
      paymentIntentId: uuidSchema.optional(),
      paymentAttemptId: uuidSchema.nullable().optional(),
      providerPaymentId: z.string().trim().min(1).nullable().optional(),
      // Server-resolved customer identity used by owned payment and order reads.
      clientId: uuidSchema.optional(),
      clientAction: checkoutClientActionSchema.optional(),
      returnUrl: z.string().url().optional(),
      statusUrl: z.string().min(1).optional(),
      subscription: z
        .object({
          requested: z.boolean(),
          cadenceDays: z.number().int().positive().max(120).nullable(),
          activationStatus: checkoutActivationStatusSchema,
        })
        .strict()
        .optional(),
      payment: z
        .object({
          requiresReusablePaymentMethod: z.boolean(),
        })
        .strict()
        .optional(),
      authoritativeQuote: createQuoteResponseSchema.optional(),
    })
    .strict()
    .superRefine((response, ctx) => {
      const subscription = response.subscription;
      if (response.checkoutKind === "one_time") {
        if (subscription && (subscription.requested || subscription.cadenceDays !== null || subscription.activationStatus !== "not_applicable")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "one-time checkout cannot report requested subscription activation",
            path: ["subscription"],
          });
        }
        return;
      }

      if (!subscription?.requested || !subscription.cadenceDays) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subscription checkout requires subscription response details",
          path: ["subscription"],
        });
      }
      if (response.payment?.requiresReusablePaymentMethod !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subscription checkout requires reusable payment method",
          path: ["payment", "requiresReusablePaymentMethod"],
        });
      }
    });

  const checkoutPriceChangedResponseSchema = z
    .object({
      contractVersion: z.literal(CHECKOUT_CONTRACT_VERSION),
      checkoutKind: checkoutKindSchema,
      status: z.literal("price_changed"),
      priceChanged: z.literal(true),
      expectedQuote: input.quoteExpectationSchema,
      authoritativeQuote: createQuoteResponseSchema,
    })
    .strict();

  const checkoutResponseSchema = z.discriminatedUnion("status", [
    checkoutSuccessResponseSchema,
    checkoutPriceChangedResponseSchema,
  ]);

  const paymentStatusRequestSchema = z
    .object({
      orderId: uuidSchema,
      paymentIntentId: uuidSchema,
      clientId: uuidSchema,
    })
    .strict();

  const paymentStatusResponseSchema = z
    .object({
      contractVersion: z.literal(CHECKOUT_CONTRACT_VERSION),
      orderId: uuidSchema,
      paymentIntentId: uuidSchema,
      status: asyncCheckoutStatusSchema,
      orderStatus: z.string().trim().min(1),
      payment: z
        .object({
          intentStatus: input.paymentIntentStatusSchema,
          attemptStatus: input.paymentAttemptStatusSchema.nullable(),
          paymentAttemptId: uuidSchema.nullable(),
          provider: z.string().trim().min(1).nullable(),
          providerPaymentId: z.string().trim().min(1).nullable(),
          updatedAt: datetimeSchema,
        })
        .strict(),
      /**
       * Why the payment failed, as a stable code. Travels BESIDE `status`, never
       * inside it: collapsing a reason into the status enum is what left every
       * decline indistinguishable from every other in the first place.
       */
      failureReason: z.string().trim().min(1).max(240).nullable().default(null),
      failureDisplay: paymentFailureDisplayReasonSchema.nullable().optional(),
      subscriptionActivation: z.object({ status: subscriptionActivationStatusSchema, subscriptionId: uuidSchema.nullable() }).strict(),
      nextAction: checkoutClientActionSchema.nullable(),
    })
    .strict();

  return { checkoutResponseSchema, paymentStatusRequestSchema, paymentStatusResponseSchema };
}

/** Acquisition promises are compared independently of money. M05 owns their schemas. */
export function createCheckoutQuoteSchemas<Money extends z.ZodType, Policy extends z.ZodType, Terms extends z.ZodType>(input: {
  moneySchema: Money; pricingPolicySchema: Policy; acquisitionTermsExpectationSchema: Terms;
}) {
  const checkoutQuoteExpectationSchema = z.object({
    totalGross: input.moneySchema, pricingPolicy: input.pricingPolicySchema.optional(),
    acquisitionTerms: input.acquisitionTermsExpectationSchema.optional(),
  }).strict();
  const checkoutQuoteAcceptanceSchema = checkoutQuoteExpectationSchema.extend({
    promotionAcceptanceToken: z.string().min(1).max(8_300).optional(),
  });
  return { checkoutQuoteExpectationSchema, checkoutQuoteAcceptanceSchema };
}

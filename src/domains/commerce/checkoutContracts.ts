import { z } from "../../lib/validation/zod.js";
import { configuratorIntentSchema } from "./configuratorIntentContracts.js";
import {
  commerceMoneySchema,
  createQuoteResponseSchema,
} from "./contracts.js";
import { pricingPolicySnapshotSchema } from "./offerPolicyContracts.js";
import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_EXECUTION_PROVIDERS,
  PAYMENT_INTENT_STATUSES,
} from "../payment/types.js";
import { checkoutPaymentExecutionSchema } from "./paymentExecutionContracts.js";
import { paymentFailureDisplayReasonSchema } from "./paymentFailureDisplayContracts.js";
import {
  isValidPolishNip,
  normalizePolishNip,
} from "../../lib/schemas/fields/taxId.js";

/**
 * Hidden configurator checkout contract.
 *
 * `subscription_initial` is a checkout intent. The runtime finalizes the initial
 * paid order as `commerce_orders.mode = 'subscription_cycle'`, so subscription
 * activation, OMS, fulfillment, and payment-control all see the same target kind.
 */

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
const INVOICE_COMPANY_NAME_MAX_LENGTH = 240;

export const invoiceBuyerSnapshotAddressSchema = z
  .object({
    line1: z.string().trim().min(3).max(160),
    line2: z.string().trim().min(1).max(160).nullable().default(null),
    city: z.string().trim().min(2).max(120),
    postalCode: z.string().trim().min(3).max(16),
    country: z.literal("PL"),
    source: z.string().trim().min(1).max(120),
  })
  .strict();

const checkoutInvoiceAddressInputSchema = invoiceBuyerSnapshotAddressSchema
  .omit({ source: true })
  .strict();

const checkoutInvoiceTaxIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    if (!/^(?:PL[\s-]*)?[\d\s-]+$/i.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "forms:fields.taxId.invalid",
      });
      return z.NEVER;
    }
    const normalizedTaxId = normalizePolishNip(value);
    if (!normalizedTaxId || !isValidPolishNip(normalizedTaxId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "forms:fields.taxId.invalid",
      });
      return z.NEVER;
    }
    return normalizedTaxId;
  });

export const checkoutInvoicePreferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("b2c_named") }).strict(),
  z
    .object({
      kind: z.literal("b2b_vat"),
      companyName: z.string().trim().min(1).max(INVOICE_COMPANY_NAME_MAX_LENGTH),
      taxId: checkoutInvoiceTaxIdSchema,
      address: checkoutInvoiceAddressInputSchema,
      email: z.string().trim().toLowerCase().email().max(320).optional(),
      contactName: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
]);

export const invoiceBuyerSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    email: z.string().trim().toLowerCase().email().max(320),
    taxId: z.string().regex(/^\d{10}$/).nullable(),
    companyName: z.string().trim().min(1).max(INVOICE_COMPANY_NAME_MAX_LENGTH).nullable(),
    source: z.literal("checkout_invoice_preference"),
    address: invoiceBuyerSnapshotAddressSchema,
  })
  .strict();

export const checkoutClientActionSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("redirect"), url: z.string().url() }).strict(),
    z
      .object({
        kind: z.literal("provider_embedded"),
        provider: z.enum(["stripe", "tpay"]),
        clientSecret: z.string().trim().min(1).optional(),
        sessionRef: z.string().trim().min(1).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("blik_code_prompt"), provider: z.literal("tpay") }).strict(),
  ])
  // Stripe's embedded Payment Element can only mount with a clientSecret. An
  // embedded action for Stripe WITHOUT one is the strand bug (no card panel ever
  // renders, /platnosc polls forever) — reject it at the contract boundary so a
  // malformed server response can never reach the FE. Tpay embedded may instead
  // carry a `sessionRef`, so the requirement is Stripe-specific.
  .superRefine((action, ctx) => {
    if (action.kind === "provider_embedded" && action.provider === "stripe" && !action.clientSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Stripe embedded checkout requires a clientSecret",
        path: ["clientSecret"],
      });
    }
  });

export const checkoutRequestSchema = z
  .object({
    intent: configuratorIntentSchema,
    /**
     * Payment provider selection. Optional; absent or `"hidden_rehearsal"`
     * preserves the configurator's existing samples-only flow. Real PSP
     * providers (`"stripe"`, `"tpay"`) require their corresponding env-driven
     * injection (W11.7) and activation flags.
     */
    paymentProvider: z.enum(PAYMENT_EXECUTION_PROVIDERS).default("hidden_rehearsal"),
    /**
     * Which payment attempt this is for the same journey. Bumped by the client
     * after a terminal decline so a retry — especially one that switches provider
     * — gets a fresh provider-attempt identity on the SAME order, instead of
     * colliding with the dead attempt's prepare key. */
    paymentAttemptSequence: z.number().int().min(0).max(50).optional(),
    paymentExecution: checkoutPaymentExecutionSchema.optional(),
    declaredBankId: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).optional(),
    /**
     * Where a redirect-based provider (Tpay BLIK / PBL) returns the buyer after
     * payment. `"public"` (default) keeps the anonymous configurator flow byte-
     * identical: the server returns the public `/skomponuj-pakiet/platnosc`
     * terminal. `"account"` is set by the in-account order flow so the server
     * builds the in-shell `/konto/zamowienie/status` return URL and the buyer
     * lands on the cream account terminal (sidebar persists). The server owns the
     * path mapping — the client only declares its context (an enum, never a raw
     * URL, so a forged request can't redirect off-origin).
     */
    returnContext: z.enum(["public", "account"]).default("public"),
    invoicePreference: checkoutInvoicePreferenceSchema.default({ kind: "b2c_named" }),
    expectedQuote: z
      .object({
        totalGross: commerceMoneySchema,
        pricingPolicy: pricingPolicySnapshotSchema.optional(),
        promotionAcceptanceToken: z.string().min(1).max(8_300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.paymentProvider !== "tpay") {
      // Stripe has no transient `paymentExecution` variant (cards + wallets run
      // through its Payment Element); one here is a mis-routed Tpay flow — reject
      // at the boundary. Rehearsal providers may carry a matching execution.
      if (request.paymentProvider === "stripe" && request.paymentExecution) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Stripe checkout must not carry a paymentExecution",
          path: ["paymentExecution"],
        });
      }
      if (request.intent.mode !== "subscription") return;
      if (!request.intent.paymentMethodIntent.saveForSubscription) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subscription checkout requires saveForSubscription",
          path: ["intent", "paymentMethodIntent", "saveForSubscription"],
        });
      }
      return;
    }

    if (request.paymentExecution?.provider !== "tpay") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tpay checkout requires Tpay paymentExecution",
        path: ["paymentExecution"],
      });
      return;
    }

    if (request.intent.mode === "subscription") {
      if (!request.intent.paymentMethodIntent.saveForSubscription) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subscription checkout requires saveForSubscription",
          path: ["intent", "paymentMethodIntent", "saveForSubscription"],
        });
      }
      if (
        request.paymentExecution.flow !== "blik_recurring_activation" &&
        request.paymentExecution.flow !== "blik_recurring_saved"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Tpay subscription checkout requires BLIK recurring activation or saved BLIK PAYID",
          path: ["paymentExecution", "flow"],
        });
      }
      return;
    }

    if (
      request.paymentExecution.flow === "blik_recurring_activation" ||
      request.paymentExecution.flow === "blik_recurring_saved"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tpay BLIK recurring checkout requires subscription checkout",
        path: ["paymentExecution", "flow"],
      });
    }
  });

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
    /**
     * Customer (clients table) UUID for this checkout. The FE uses it as the
     * server-side ownership guard for `/api/bff/commerce/payment-status` and
     * post-payment order recap reads. Present on paid/processing checkout
     * responses so receipt money can be fetched from `commerce_orders`.
     */
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
    expectedQuote: z.object({
      totalGross: commerceMoneySchema,
      pricingPolicy: pricingPolicySnapshotSchema.optional(),
    }).strict(),
    authoritativeQuote: createQuoteResponseSchema,
  })
  .strict();

export const checkoutResponseSchema = z.discriminatedUnion("status", [
  checkoutSuccessResponseSchema,
  checkoutPriceChangedResponseSchema,
]);

export const paymentStatusRequestSchema = z
  .object({
    orderId: uuidSchema,
    paymentIntentId: uuidSchema,
    clientId: uuidSchema,
  })
  .strict();

export const paymentStatusResponseSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_CONTRACT_VERSION),
    orderId: uuidSchema,
    paymentIntentId: uuidSchema,
    status: asyncCheckoutStatusSchema,
    orderStatus: z.string().trim().min(1),
    payment: z
      .object({
        intentStatus: z.enum(PAYMENT_INTENT_STATUSES),
        attemptStatus: z.enum(PAYMENT_ATTEMPT_STATUSES).nullable(),
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

export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type CheckoutKind = z.infer<typeof checkoutKindSchema>;
export type CheckoutInvoicePreference = z.infer<typeof checkoutInvoicePreferenceSchema>;
export type InvoiceBuyerSnapshot = z.infer<typeof invoiceBuyerSnapshotSchema>;
export type PaymentStatusRequest = z.infer<typeof paymentStatusRequestSchema>;
export type PaymentStatusResponse = z.infer<typeof paymentStatusResponseSchema>;
export type CheckoutClientAction = z.infer<typeof checkoutClientActionSchema>;

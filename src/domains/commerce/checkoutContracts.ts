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

export { CHECKOUT_CONTRACT_VERSION, ASYNC_CHECKOUT_STATUSES, checkoutKindSchema, checkoutActivationStatusSchema, asyncCheckoutStatusSchema, subscriptionActivationStatusSchema } from "@openlup/platform/commerce";
export type { AsyncCheckoutStatus } from "@openlup/platform/commerce/contracts";
import { checkoutKindSchema, invoiceBuyerSnapshotAddressCoreSchema, checkoutRequestCoreSchema, createCheckoutResponseSchemas, createCheckoutQuoteSchemas } from "@openlup/platform/commerce";
import { acquisitionTermsExpectationSchema } from "@openlup/platform/pricing/browser";
const { checkoutQuoteExpectationSchema, checkoutQuoteAcceptanceSchema } = createCheckoutQuoteSchemas({ moneySchema: commerceMoneySchema, pricingPolicySchema: pricingPolicySnapshotSchema, acquisitionTermsExpectationSchema });
const INVOICE_COMPANY_NAME_MAX_LENGTH = 240;

export const invoiceBuyerSnapshotAddressSchema = invoiceBuyerSnapshotAddressCoreSchema.extend({ country: z.literal("PL") });

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

// Preserve legacy field and issue order while reusing the neutral validators.
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
    paymentAttemptSequence: checkoutRequestCoreSchema.shape.paymentAttemptSequence,
    paymentExecution: checkoutPaymentExecutionSchema.optional(),
    declaredBankId: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).optional(),
    returnContext: checkoutRequestCoreSchema.shape.returnContext,
    invoicePreference: checkoutInvoicePreferenceSchema.default({ kind: "b2c_named" }),
    expectedQuote: checkoutQuoteAcceptanceSchema.optional(),
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

export const { checkoutResponseSchema, paymentStatusRequestSchema, paymentStatusResponseSchema } = createCheckoutResponseSchemas({
  quoteSchema: createQuoteResponseSchema, quoteExpectationSchema: checkoutQuoteExpectationSchema,
  clientActionSchema: checkoutClientActionSchema, paymentIntentStatusSchema: z.enum(PAYMENT_INTENT_STATUSES),
  paymentAttemptStatusSchema: z.enum(PAYMENT_ATTEMPT_STATUSES), failureDisplaySchema: paymentFailureDisplayReasonSchema,
});

export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type CheckoutKind = z.infer<typeof checkoutKindSchema>;
export type CheckoutInvoicePreference = z.infer<typeof checkoutInvoicePreferenceSchema>;
export type InvoiceBuyerSnapshot = z.infer<typeof invoiceBuyerSnapshotSchema>;
export type PaymentStatusRequest = z.infer<typeof paymentStatusRequestSchema>;
export type PaymentStatusResponse = z.infer<typeof paymentStatusResponseSchema>;
export type CheckoutClientAction = z.infer<typeof checkoutClientActionSchema>;

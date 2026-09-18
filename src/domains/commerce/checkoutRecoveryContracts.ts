import { z } from "../../lib/validation/zod.js";
import { commerceMoneySchema } from "./contracts.js";
import {
  asyncCheckoutStatusSchema,
  checkoutClientActionSchema,
} from "./checkoutContracts.js";
import { PAYMENT_EXECUTION_PROVIDERS } from "../payment/types.js";
import { checkoutPaymentExecutionSchema } from "./paymentExecutionContracts.js";

/**
 * Checkout-recovery contracts (W4).
 *
 * The recovery deep-link `/konto/dokoncz-platnosc?token=…` lets a customer
 * complete payment for the EXISTING unpaid order (subscription first-cycle OR
 * one-time) with NO login. Two BFF endpoints back the pay page:
 *
 *  - `redeem` validates an open checkout and returns its canonical internal
 *    `paymentIntentId`; capability-aware clients may instead revalidate the
 *    frozen basket of a system-expired checkout.
 *  - `pay` mints a FRESH provider attempt only after redemption proves there is
 *    no active provider attempt. An exact active attempt may instead resume its
 *    current Tpay redirect or Stripe client_secret after canonical readback.
 *    For the local rehearsal/simulator, the handler applies the result so the
 *    success path flips order→paid + sub pending_activation→active + pins
 *    reservations.
 *
 * Manual cancellation, money-moved evidence, or commercial drift is terminal.
 * Existing callers that do not advertise the recreation capability keep the
 * earlier strict fallback behavior.
 */

export const CHECKOUT_RECOVERY_CONTRACT_VERSION = "commerce.checkout-recovery.v1";

const uuidSchema = z.guid();

export const checkoutRecoveryModeSchema = z.enum(["subscription_cycle", "one_time_order"]);
export type CheckoutRecoveryMode = z.infer<typeof checkoutRecoveryModeSchema>;

export const checkoutRecoveryFallbackSchema = z.enum(["fresh_checkout", "customer_account"]);
export type CheckoutRecoveryFallback = z.infer<typeof checkoutRecoveryFallbackSchema>;

export const checkoutRecoveryTerminalStatusSchema = z.enum(["paid", "cancelled", "order_changed"]);
export type CheckoutRecoveryTerminalStatus = z.infer<typeof checkoutRecoveryTerminalStatusSchema>;

export const checkoutRecoveryKindSchema = z.enum(["retry_existing", "recreate_expired"]);
export type CheckoutRecoveryKind = z.infer<typeof checkoutRecoveryKindSchema>;

export const CHECKOUT_RECOVERY_RECREATE_CAPABILITY = "recreate_expired_order" as const;
export const CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY = "resolve_active_payment" as const;

// ---------------------------------------------------------------------------
// redeem
// ---------------------------------------------------------------------------

export const checkoutRecoveryRedeemRequestSchema = z
  .object({
    token: z.string().trim().min(1).max(512),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  })
  .strict();

const checkoutRecoveryOrderSummarySchema = z
  .object({
    orderId: uuidSchema,
    orderRef: z.string().trim().min(1),
    orderNumber: z.string().trim().min(1),
    clientId: uuidSchema,
    paymentIntentId: uuidSchema.nullable(),
    mode: checkoutRecoveryModeSchema,
    total: commerceMoneySchema,
    petName: z.string().trim().min(1).nullable(),
    cadenceDays: z.number().int().positive().max(120).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CheckoutRecoveryOrderSummary = z.infer<typeof checkoutRecoveryOrderSummarySchema>;

export const checkoutRecoveryPaymentResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retry_new") }).strict(),
  z.object({ kind: z.literal("resume_existing"), clientAction: checkoutClientActionSchema }).strict(),
  z.object({ kind: z.literal("awaiting_provider") }).strict(),
  z.object({ kind: z.literal("manual_review") }).strict(),
]);
export type CheckoutRecoveryPaymentResolution = z.infer<typeof checkoutRecoveryPaymentResolutionSchema>;

const checkoutRecoveryRedeemRecoverableSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RECOVERY_CONTRACT_VERSION),
    recoverable: z.literal(true),
    recoveryKind: checkoutRecoveryKindSchema.optional(),
    order: checkoutRecoveryOrderSummarySchema,
    // Additive and capability-gated: old deep-link clients keep their exact
    // response shape, while new clients may resume an active PSP object.
    paymentResolution: checkoutRecoveryPaymentResolutionSchema.optional(),
  })
  .strict();

const checkoutRecoveryRedeemUnrecoverableSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RECOVERY_CONTRACT_VERSION),
    recoverable: z.literal(false),
    // W4a: the token/order is dead (expired, paid already, or swept→cancelled).
    // One-time orders can start a brand-new checkout; subscription-linked orders
    // stay in account context to avoid duplicate subscription/order data.
    fallback: checkoutRecoveryFallbackSchema,
    // A Stripe webhook may settle before the browser returns from 3DS. The
    // token is then no longer payable, but it still authorizes navigation to
    // the already-paid order's thank-you page.
    paidOrder: z.object({
      orderId: uuidSchema,
      orderRef: z.string().trim().min(1),
      clientId: uuidSchema,
    }).strict().optional(),
    // Terminal local truth observed while redeeming a dead link. `fallback`
    // remains present for old clients; new clients show the terminal state
    // instead of offering another payment path.
    terminalStatus: checkoutRecoveryTerminalStatusSchema.optional(),
  })
  .strict();

export const checkoutRecoveryRedeemResponseSchema = z.discriminatedUnion("recoverable", [
  checkoutRecoveryRedeemRecoverableSchema,
  checkoutRecoveryRedeemUnrecoverableSchema,
]);

export type CheckoutRecoveryRedeemRequest = z.infer<typeof checkoutRecoveryRedeemRequestSchema>;
export type CheckoutRecoveryRedeemResponse = z.infer<typeof checkoutRecoveryRedeemResponseSchema>;

// ---------------------------------------------------------------------------
// pay
// ---------------------------------------------------------------------------

export const checkoutRecoveryPayRequestSchema = z
  .object({
    token: z.string().trim().min(1).max(512),
    // Idempotency root for the fresh attempt. The FE mints a new one per click so
    // a re-press resumes rather than double-charges; payment-control idempotency
    // keys + findResumableOrderForClient guard the rest.
    idempotencyKey: z.string().trim().min(8).max(200),
    // W4a: the provider is chosen FRESH at click-time (old artifact is dead).
    paymentProvider: z.enum(PAYMENT_EXECUTION_PROVIDERS).default("hidden_rehearsal"),
    paymentExecution: checkoutPaymentExecutionSchema.optional(),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  })
  .strict();

export const checkoutRecoveryPayResponseSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RECOVERY_CONTRACT_VERSION),
    orderId: uuidSchema,
    paymentIntentId: uuidSchema,
    clientId: uuidSchema,
    status: asyncCheckoutStatusSchema,
    paymentAttemptId: uuidSchema.nullable(),
    provider: z.string().trim().min(1),
    providerPaymentId: z.string().trim().min(1).nullable(),
    failureReason: z.string().trim().min(1).max(240).nullable().optional(),
    clientAction: checkoutClientActionSchema,
  })
  .strict();

export type CheckoutRecoveryPayRequest = z.infer<typeof checkoutRecoveryPayRequestSchema>;
export type CheckoutRecoveryPayResponse = z.infer<typeof checkoutRecoveryPayResponseSchema>;

// ---------------------------------------------------------------------------
// start (W5) — in-account CTA
// ---------------------------------------------------------------------------

/**
 * `POST /api/bff/customers/checkout-recovery/start` (W5). The in-account
 * "Dokończ płatność" CTA. Unlike the email deep-link (which already carries a W1
 * token), a logged-in customer has no token, so this authed endpoint resolves
 * the customer's own unpaid order and mints a FRESH recovery token server-side.
 * The CTA then navigates to the same W4 pay-page with the raw token — one
 * redeem/pay path for the email and both in-account entry points.
 *
 * Two entry shapes (exactly one key, both `.strict()`):
 * - `{ subscriptionId }` — the subscription panel CTA (resolves the newest
 *   `pending_payment` order for that subscription).
 * - `{ orderId }` — the orders-list CTA (resolves that specific `pending_payment`
 *   order). Covers one-time AND subscription-first-cycle orders shown in the list.
 */
export const checkoutRecoveryStartRequestSchema = z.union([
  z.object({ subscriptionId: uuidSchema }).strict(),
  z.object({ orderId: uuidSchema }).strict(),
]);

const checkoutRecoveryStartRecoverableSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RECOVERY_CONTRACT_VERSION),
    recoverable: z.literal(true),
    // Raw token for the deep-link (stored only as its hash). Single-use-ish: the
    // W4 redeem path is read-only, so a token survives several attempts within TTL.
    token: z.string().trim().min(1).max(512),
    mode: checkoutRecoveryModeSchema,
  })
  .strict();

const checkoutRecoveryStartUnrecoverableSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RECOVERY_CONTRACT_VERSION),
    recoverable: z.literal(false),
    // No unpaid order to recover (already paid, swept→cancelled, or none). The
    // fallback is explicit so subscription customers stay in account context.
    fallback: checkoutRecoveryFallbackSchema,
  })
  .strict();

export const checkoutRecoveryStartResponseSchema = z.discriminatedUnion("recoverable", [
  checkoutRecoveryStartRecoverableSchema,
  checkoutRecoveryStartUnrecoverableSchema,
]);

export type CheckoutRecoveryStartRequest = z.infer<typeof checkoutRecoveryStartRequestSchema>;
export type CheckoutRecoveryStartResponse = z.infer<typeof checkoutRecoveryStartResponseSchema>;

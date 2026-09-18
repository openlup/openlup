import { z } from "../../lib/validation/zod.js";
import { asyncCheckoutStatusSchema, checkoutClientActionSchema } from "./checkoutContracts.js";

export const CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION = "commerce.checkout-inline-recovery.v1";

const identity = {
  orderId: z.guid(),
  clientId: z.guid(),
  paymentIntentId: z.guid(),
  journeyId: z.string().regex(/^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  expectedPaymentAttemptId: z.guid(),
  /** Distinguishes browser-tab submissions in the stable server transition fingerprint; never used as the payment key. */
  retryRequestId: z.guid(),
};

const cardRequest = z.object({
  ...identity,
  paymentMethod: z.literal("card"),
  paymentProvider: z.literal("stripe"),
}).strict();

const blikRequest = z.object({
  ...identity,
  paymentMethod: z.literal("blik"),
  paymentProvider: z.literal("tpay"),
  paymentExecution: z.union([
    z.object({ provider: z.literal("tpay"), flow: z.literal("blik_one_time"), blikToken: z.string().regex(/^\d{6}$/) }).strict(),
    z.object({ provider: z.literal("tpay"), flow: z.literal("blik_recurring_activation"), blikToken: z.string().regex(/^\d{6}$/), recurringModel: z.literal("O") }).strict(),
  ]),
}).strict();

export const checkoutInlineRecoveryPayRequestSchema = z.discriminatedUnion("paymentMethod", [
  cardRequest,
  blikRequest,
]);

export const checkoutInlineRecoveryPayResponseSchema = z.object({
  contractVersion: z.literal(CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION),
  orderId: z.guid(),
  orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
  paymentIntentId: z.guid(),
  clientId: z.guid(),
  status: asyncCheckoutStatusSchema,
  paymentAttemptId: z.guid().nullable(),
  provider: z.string().trim().min(1),
  providerPaymentId: z.string().trim().min(1).nullable(),
  failureReason: z.string().trim().min(1).max(240).nullable().optional(),
  clientAction: checkoutClientActionSchema,
}).strict();

export type CheckoutInlineRecoveryPayRequest = z.infer<typeof checkoutInlineRecoveryPayRequestSchema>;
export type CheckoutInlineRecoveryPayResponse = z.infer<typeof checkoutInlineRecoveryPayResponseSchema>;

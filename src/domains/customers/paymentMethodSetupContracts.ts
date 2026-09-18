import { z } from "../../lib/validation/zod.js";

/**
 * Account "update card" (CJ63-A) — a session-authenticated, token-free sibling of the
 * dunning-recovery setup-method flow. A logged-in customer mints a Stripe SetupIntent for
 * one of THEIR subscriptions; the FE confirms a new card via the Payment Element, and the
 * `setup_intent.succeeded` webhook binds the subscription-scoped `commerce_payment_method_refs`
 * row (deactivate-before-insert) so the next actually due cycle uses the new card.
 */
export const CUSTOMER_PAYMENT_METHOD_SETUP_CONTRACT_VERSION = "customer.payment-method-setup.v1" as const;

export const customerPaymentMethodSetupRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(180),
    subscriptionId: z.string().uuid(),
  })
  .strict();

export const customerPaymentMethodSetupResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_PAYMENT_METHOD_SETUP_CONTRACT_VERSION),
    setup: z.object({
      clientSecret: z.string().min(1),
      setupIntentId: z.string().min(1),
      subscriptionId: z.string().uuid(),
    }),
  })
  .strict();

export type CustomerPaymentMethodSetupRequest = z.infer<typeof customerPaymentMethodSetupRequestSchema>;
export type CustomerPaymentMethodSetupResponse = z.infer<typeof customerPaymentMethodSetupResponseSchema>;

import { PAYMENT_FAILURE_CUSTOMER_CAUSES } from "@openlup/core/payment";

import { z } from "../../lib/validation/zod.js";

// Bumped to v2 when the setup response gained the facts the repair page needs to
// confirm which case it is repairing. The versioned unit is the payment-recovery
// CONTRACT SURFACE, not one endpoint, so the other two recovery responses declare
// v2 too although neither changed shape. That is deliberate: a client that can
// read one of these responses can read all three, and three drifting version
// literals would make that guarantee unstateable.
export const PAYMENT_RECOVERY_CONTRACT_VERSION = "payment.recovery.v2" as const;

const datetimeSchema = z.string().datetime({ offset: true });

export const paymentRecoveryRedeemRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(180),
    recoveryToken: z.string().trim().min(32).max(256),
    paymentMethodRef: z.string().trim().min(1).max(240),
    paymentMethodKind: z.string().trim().min(1).max(80),
    requestedAt: datetimeSchema,
  })
  .strict();

export const paymentRecoveryRedeemResponseSchema = z
  .object({
    contractVersion: z.literal(PAYMENT_RECOVERY_CONTRACT_VERSION),
    recovery: z
      .object({
        caseId: z.guid(),
        subscriptionId: z.guid(),
        cycleId: z.guid(),
        orderId: z.guid(),
        purpose: z.enum(["repair_payment", "resume_subscription"]),
        nextAction: z.enum(["retry_existing_cycle", "resume_subscription"]),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const paymentRecoveryResendLatestLinkRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(180),
  })
  .strict();

export const paymentRecoveryResendLatestLinkResponseSchema = z
  .object({
    contractVersion: z.literal(PAYMENT_RECOVERY_CONTRACT_VERSION),
    accepted: z.literal(true),
  })
  .strict();

/**
 * Wave D-4a — request a Stripe SetupIntent client_secret for the recovery
 * flow. The FE renders Stripe Elements bound to this secret, the customer
 * enters a new card, `stripe.confirmSetup` returns the new payment_method,
 * and then the FE calls /redeem with the method ref. The SetupIntent is
 * metadata-tagged with `subscriptionId` so the existing Wave C webhook
 * extraction binds the new method to the subscription on success.
 */
export const paymentRecoverySetupMethodRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(180),
    recoveryToken: z.string().trim().min(32).max(256),
  })
  .strict();

export const paymentRecoverySetupMethodResponseSchema = z
  .object({
    contractVersion: z.literal(PAYMENT_RECOVERY_CONTRACT_VERSION),
    setup: z
      .object({
        clientSecret: z.string().min(1),
        setupIntentId: z.string().min(1),
        caseId: z.guid(),
        subscriptionId: z.guid(),
        // The capture surface promises different outcomes per purpose: a repair
        // retries the failed cycle, a resume only revives the subscription.
        purpose: z.enum(["repair_payment", "resume_subscription"]),
        replayed: z.boolean(),
        // The facts the page needs to prove to the payer that it is repairing the
        // case the email named. All three are DISPLAY data and all three are
        // nullable: the amount is absent when the case carries no readable order,
        // and the cause is `unknown` for every case whose class was never
        // recorded. A page that receives nulls renders what it rendered before
        // they existed -- never a placeholder, never a guess.
        amountMinor: z.number().int().nullable(),
        currency: z.string().trim().length(3).nullable(),
        failureCause: z.enum(PAYMENT_FAILURE_CUSTOMER_CAUSES),
      })
      .strict(),
  })
  .strict();

export type PaymentRecoveryRedeemRequest = z.infer<typeof paymentRecoveryRedeemRequestSchema>;
export type PaymentRecoveryRedeemResponse = z.infer<typeof paymentRecoveryRedeemResponseSchema>;
export type PaymentRecoveryResendLatestLinkRequest = z.infer<
  typeof paymentRecoveryResendLatestLinkRequestSchema
>;
export type PaymentRecoveryResendLatestLinkResponse = z.infer<
  typeof paymentRecoveryResendLatestLinkResponseSchema
>;
export type PaymentRecoverySetupMethodRequest = z.infer<
  typeof paymentRecoverySetupMethodRequestSchema
>;
export type PaymentRecoverySetupMethodResponse = z.infer<
  typeof paymentRecoverySetupMethodResponseSchema
>;

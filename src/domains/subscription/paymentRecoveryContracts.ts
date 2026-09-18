import { z } from "../../lib/validation/zod.js";

export const SUBSCRIPTION_PAYMENT_RECOVERY_CONTRACT_VERSION = "subscription.payment_recovery.v1";

export const subscriptionPaymentRecoveryRequestSchema = z
  .object({
    recoveryToken: z.string().trim().min(32).max(256),
    paymentMethodRef: z.string().trim().min(1).max(240),
    paymentMethodKind: z.string().trim().min(1).max(80),
  })
  .strict();

export const subscriptionPaymentRecoveryResponseSchema = z
  .object({
    contractVersion: z.literal(SUBSCRIPTION_PAYMENT_RECOVERY_CONTRACT_VERSION),
    recovery: z
      .object({
        caseId: z.guid(),
        subscriptionId: z.guid(),
        cycleId: z.guid(),
        nextAction: z.enum(["retry_existing_cycle", "resume_subscription"]),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type SubscriptionPaymentRecoveryRequest = z.infer<
  typeof subscriptionPaymentRecoveryRequestSchema
>;
export type SubscriptionPaymentRecoveryResponse = z.infer<
  typeof subscriptionPaymentRecoveryResponseSchema
>;

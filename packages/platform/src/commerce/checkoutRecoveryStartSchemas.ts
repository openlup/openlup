import { z } from 'zod';

export const CHECKOUT_RECOVERY_START_CONTRACT_VERSION = 'commerce.checkout-recovery.v1' as const;
export const checkoutRecoveryStartRequestSchema = z.union([
  z.object({ subscriptionId: z.guid() }).strict(),
  z.object({ orderId: z.guid() }).strict(),
]);
export const checkoutRecoveryStartResponseSchema = z.discriminatedUnion('recoverable',[
  z.object({ contractVersion: z.literal(CHECKOUT_RECOVERY_START_CONTRACT_VERSION),recoverable: z.literal(true),
    token: z.string().trim().min(1).max(512),mode: z.enum(['subscription_cycle','one_time_order']) }).strict(),
  z.object({ contractVersion: z.literal(CHECKOUT_RECOVERY_START_CONTRACT_VERSION),recoverable: z.literal(false),
    fallback: z.enum(['fresh_checkout','customer_account']) }).strict(),
]);
export type CheckoutRecoveryStartRequest = z.infer<typeof checkoutRecoveryStartRequestSchema>;
export type CheckoutRecoveryStartResponse = z.infer<typeof checkoutRecoveryStartResponseSchema>;

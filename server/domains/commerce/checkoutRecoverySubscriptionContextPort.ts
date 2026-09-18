export interface CheckoutRecoverySubscriptionContextPort {
  clientHasLiveOrPendingSubscription(input: { clientId: string }): Promise<boolean>;
}

export const RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES = [
  "pending_activation",
  "active",
  "paused",
  "activation_failed",
] as const;

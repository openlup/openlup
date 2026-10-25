export type RecoveryDestinationIntent =
  | "checkout_recovery"
  | "account_payment_recovery"
  | "customer_dashboard"
  | "fresh_checkout";

export type RecoveryDestinationState =
  | "recoverable"
  | "unrecoverable"
  | "terminal_expired";

export type RecoveryDestinationSource =
  | "checkout_recovery"
  | "subscription_dunning"
  | "checkout_expired";

export interface RecoveryDestinationPolicyInput {
  state: RecoveryDestinationState;
  source: RecoveryDestinationSource;
  orderMode?: "one_time_order" | "subscription_cycle" | null;
  hasOrderSubscription?: boolean;
  requestedSubscriptionContext?: boolean;
  clientHasLiveOrPendingSubscription?: boolean;
}
